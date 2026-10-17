#include <Arduino.h>
#include "cloud_wake.h"

#if __has_include("cloud_settings.h")
#include "cloud_settings.h"
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <algorithm>
#include "network_wake.h"

namespace {
Preferences state;
String lastHandled;
String lastResult;
uint32_t lastPoll = 0;
uint32_t intervalMs = 5000;
char report[63] = "waiting-wifi";
portMUX_TYPE reportLock = portMUX_INITIALIZER_UNLOCKED;
struct CommandRecord {
  char id[37];
  char result[7];
};

bool persistCommand() {
  CommandRecord record{};
  snprintf(record.id, sizeof(record.id), "%s", lastHandled.c_str());
  snprintf(record.result, sizeof(record.result), "%s", lastResult.c_str());
  return state.putBytes("command", &record, sizeof(record)) == sizeof(record);
}

void setStatus(const char *message) {
  portENTER_CRITICAL(&reportLock);
  snprintf(report, sizeof(report), "%s", message);
  portEXIT_CRITICAL(&reportLock);
}

void poll() {
  WiFiClientSecure client;
  client.setCACert(WAKE_CA_CERT);
  client.setHandshakeTimeout(8);
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  http.setUserAgent("USB-Wake/1.0");
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(client, String(WAKE_CLOUD_URL) + "/device/poll")) {
    setStatus("https-init-failed");
    return;
  }
  http.addHeader("Authorization", String("Bearer ") + WAKE_DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  JsonDocument request;
  request["lastHandled"] = lastHandled;
  if (!lastResult.isEmpty()) request["lastResult"] = lastResult;
  String payload;
  serializeJson(request, payload);
  const int code = http.POST(payload);
  if (code != 200) {
    char message[63];
    snprintf(message, sizeof(message), "poll-http=%d", code);
    setStatus(message);
    http.end();
    return;
  }
  if (http.getSize() > 2048) {
    setStatus("response-too-large");
    http.end();
    return;
  }
  String response = http.getString();
  http.end();
  JsonDocument data;
  if (response.length() > 2048 || deserializeJson(data, response) ||
      data["protocol"].as<int>() != 1) {
    setStatus("invalid-response");
    return;
  }
  intervalMs = 5000;
  const char *id = data["command"]["id"] | "";
  if (!*id) {
    setStatus("online");
    return;
  }
  const uint64_t expires = data["command"]["expiresAt"] | uint64_t(0);
  const uint64_t serverNow = data["serverTime"] | uint64_t(0);
  if (strlen(id) != 36 || expires <= serverNow || expires - serverNow > 30000 ||
      expires <= static_cast<uint64_t>(time(nullptr)) * 1000) {
    setStatus("expired-or-invalid-command");
    return;
  }
  if (lastHandled == id) {
    setStatus("duplicate-skipped");
    return;
  }
  // Persist before sending. A reset must never replay an old wake command.
  lastHandled = id;
  lastResult = "failed";
  if (!persistCommand()) {
    setStatus("persist-failed");
    return;
  }
  const uint32_t before = networkSentCount();
  if (requestNetworkWake()) {
    const uint32_t started = millis();
    while (millis() - started < 800) {
      networkLoop();
      delay(10);
    }
    if (networkSentCount() > before && networkLastSendSucceeded()) {
      lastResult = "sent";
    }
  }
  persistCommand();
  setStatus(lastResult == "sent" ? "wake-packets-sent" : "wake-send-failed");
}
}  // namespace

void cloudBegin() {
  state.begin("cloud-wake", false);
  CommandRecord record{};
  if (state.getBytesLength("command") == sizeof(record)) {
    state.getBytes("command", &record, sizeof(record));
    record.id[36] = '\0';
    record.result[6] = '\0';
    lastHandled = record.id;
    lastResult = record.result;
  }
  configTime(0, 0, "ntp.aliyun.com", "time.cloudflare.com", "pool.ntp.org");
}

void cloudLoop() {
  if (WiFi.status() != WL_CONNECTED) return;
  const uint32_t now = millis();
  if (now - lastPoll < intervalMs) return;
  lastPoll = now;
  if (time(nullptr) < 1700000000) {
    setStatus("waiting-clock-sync");
    return;
  }
  intervalMs = std::min<uint32_t>(intervalMs * 2, 60000);
  poll();
  lastPoll = millis();
}

void cloudReport(uint8_t *buffer) {
  portENTER_CRITICAL(&reportLock);
  memcpy(buffer, report, sizeof(report));
  portEXIT_CRITICAL(&reportLock);
}
#else
void cloudBegin() {}
void cloudLoop() {}
void cloudReport(uint8_t *buffer) {
  memset(buffer, 0, 63);
  strcpy(reinterpret_cast<char *>(buffer), "not-configured");
}
#endif
