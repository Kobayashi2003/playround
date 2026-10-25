#include "ota.h"
#include <Arduino.h>

#if __has_include("cloud_settings.h")
#include "cloud_settings.h"
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <esp_ota_ops.h>
#include <algorithm>
#include <mbedtls/sha256.h>
#include "config.h"

namespace {
char runningDigest[65] = "";
bool onProbation = false;
bool confirmed = false;

void toHex(const uint8_t *bytes, char *out) {
  for (int i = 0; i < 32; ++i) sprintf(out + i * 2, "%02x", bytes[i]);
}

// Writes the download into the spare app slot while hashing it. The image
// ends with the SHA-256 of everything before it; verify() checks that digest
// and the one the relay announced before the slot may become bootable.
class ImageSink : public Stream {
 public:
  explicit ImageSink(uint32_t size) : size_(size), hashed_(size - 32) {
    mbedtls_sha256_init(&sha_);
    mbedtls_sha256_starts_ret(&sha_, 0);
  }
  ~ImageSink() override { mbedtls_sha256_free(&sha_); }

  size_t write(const uint8_t *data, size_t length) override {
    if (received_ + length > size_ ||
        Update.write(const_cast<uint8_t *>(data), length) != length) {
      return 0;
    }
    if (received_ < hashed_) {
      mbedtls_sha256_update_ret(
          &sha_, data, std::min<uint32_t>(length, hashed_ - received_));
    }
    for (size_t i = 0; i < length; ++i) {
      if (received_ + i >= hashed_) tail_[received_ + i - hashed_] = data[i];
    }
    received_ += length;
    return length;
  }
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}

  uint32_t received() const { return received_; }

  bool verify(const char *expected) {
    if (received_ != size_) return false;
    uint8_t digest[32];
    mbedtls_sha256_finish_ret(&sha_, digest);
    char hex[65];
    toHex(digest, hex);
    return memcmp(digest, tail_, sizeof(tail_)) == 0 &&
           strcmp(hex, expected) == 0;
  }

 private:
  const uint32_t size_;
  const uint32_t hashed_;
  uint32_t received_ = 0;
  uint8_t tail_[32]{};
  mbedtls_sha256_context sha_;
};

uint8_t block[1024];

// Reads exactly `length` bytes, failing only after kOtaStallMs with no data.
bool readExact(WiFiClient &stream, uint8_t *out, size_t length) {
  uint32_t lastData = millis();
  while (length) {
    const int got = stream.read(out, length);
    if (got > 0) {
      out += got;
      length -= got;
      lastData = millis();
    } else if (millis() - lastData > config::kOtaStallMs) {
      return false;
    } else {
      delay(2);
    }
  }
  return true;
}

bool pump(WiFiClient &stream, ImageSink &sink, uint32_t length) {
  while (length) {
    const size_t part = std::min<uint32_t>(sizeof(block), length);
    if (!readExact(stream, block, part) || sink.write(block, part) != part) {
      return false;
    }
    length -= part;
  }
  return true;
}

bool readChunked(WiFiClient &stream, ImageSink &sink) {
  for (;;) {
    char line[20];
    size_t used = 0;
    for (uint8_t c = 0; c != '\n';) {
      if (!readExact(stream, &c, 1)) return false;
      if (used < sizeof(line) - 1) line[used++] = c;
    }
    line[used] = '\0';
    const uint32_t length = strtoul(line, nullptr, 16);
    if (length == 0) return true;
    uint8_t crlf[2];
    if (!pump(stream, sink, length) || !readExact(stream, crlf, 2)) {
      return false;
    }
  }
}
}  // namespace

// Called by the Arduino core at boot. Returning true leaves a freshly
// installed image unconfirmed, so otaLoop() can still roll it back.
extern "C" bool verifyRollbackLater() { return true; }

void otaBegin() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  uint8_t digest[32];
  if (esp_partition_get_sha256(running, digest) == ESP_OK) {
    toHex(digest, runningDigest);
  }
  esp_ota_img_states_t state;
  onProbation = esp_ota_get_state_partition(running, &state) == ESP_OK &&
                state == ESP_OTA_IMG_PENDING_VERIFY;
}

const char *otaRunningDigest() { return runningDigest; }

const char *otaBuild() { return FIRMWARE_BUILD; }

void otaConfirm() {
  if (onProbation && !confirmed) {
    esp_ota_mark_app_valid_cancel_rollback();
  }
  confirmed = true;
}

void otaLoop() {
  if (onProbation && !confirmed && millis() > config::kOtaConfirmMs) {
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}

const char *otaInstall(const char *expected, uint32_t size) {
  static char reason[48];
  if (size <= 32) return "ota-invalid-offer";
  WiFiClientSecure client;
  client.setCACert(WAKE_CA_CERT);
  client.setHandshakeTimeout(15);
  HTTPClient http;
  http.setTimeout(15000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(client, String(WAKE_CLOUD_URL) + "/device/firmware")) {
    return "ota-begin-failed";
  }
  http.addHeader("Authorization", String("Bearer ") + WAKE_DEVICE_TOKEN);
  const char *wanted[] = {"Transfer-Encoding"};
  http.collectHeaders(wanted, 1);
  const int code = http.GET();
  if (code != 200) {
    http.end();
    snprintf(reason, sizeof(reason), "ota-http=%d", code);
    return reason;
  }
  if (!Update.begin(size)) {
    http.end();
    snprintf(reason, sizeof(reason), "ota-update-begin=%u", Update.getError());
    return reason;
  }
  // Cloudflare delivers the image chunked without Content-Length, so the
  // size comes from the relay's offer. HTTPClient's own body reader gives up
  // mid-chunk when connected() blips, so the body is decoded here.
  ImageSink sink(size);
  WiFiClient &stream = *http.getStreamPtr();
  const bool ok = http.header("Transfer-Encoding").equalsIgnoreCase("chunked")
                      ? readChunked(stream, sink)
                      : pump(stream, sink, size);
  http.end();
  if (!ok || sink.received() != size) {
    Update.abort();
    snprintf(reason, sizeof(reason), "ota-short=%lu/%lu",
             static_cast<unsigned long>(sink.received()),
             static_cast<unsigned long>(size));
    return reason;
  }
  if (!sink.verify(expected)) {
    Update.abort();
    return "ota-digest-mismatch";
  }
  if (!Update.end(true)) {
    snprintf(reason, sizeof(reason), "ota-update-end=%u", Update.getError());
    return reason;
  }
  delay(200);
  ESP.restart();
  return "ota-restart-failed";
}
#else
void otaBegin() {}
const char *otaRunningDigest() { return ""; }
const char *otaBuild() { return FIRMWARE_BUILD; }
void otaConfirm() {}
void otaLoop() {}
const char *otaInstall(const char *, uint32_t) { return "not-configured"; }
#endif
