#include "pc_link.h"
#include <algorithm>
#include <atomic>
#include "config.h"
#include "hid_protocol.h"

namespace {
portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
std::atomic<uint32_t> lastPoll{0};
std::atomic<bool> polledOnce{false};
std::atomic<bool> needCatalogue{true};

char staging[config::kMaxCatalogueBytes + 1]{};
uint16_t received = 0;
uint16_t expected = 0;
volatile bool catalogueReady = false;

bool hasCommand = false;
uint8_t commandId[16]{};
char commandAction[33]{};
volatile bool resultReady = false;
bool resultOk = false;
uint8_t resultId[16]{};

bool parseUuid(const char *text, uint8_t *out) {
  size_t written = 0;
  for (size_t i = 0; text[i] && written < 16; ++i) {
    if (text[i] == '-') continue;
    char pair[3] = {text[i], text[i + 1], 0};
    if (!isxdigit(pair[0]) || !isxdigit(pair[1])) return false;
    out[written++] = static_cast<uint8_t>(strtoul(pair, nullptr, 16));
    ++i;
  }
  return written == 16;
}
}  // namespace

void pcPoll(uint8_t *buffer) {
  lastPoll = millis();
  polledOnce = true;
  buffer[0] = hid::kPollMagic;
  portENTER_CRITICAL(&lock);
  buffer[1] = (needCatalogue ? hid::kPollNeedCatalogue : 0) |
              (hasCommand ? hid::kPollHasCommand : 0);
  if (hasCommand) {
    memcpy(buffer + 2, commandId, sizeof(commandId));
    memcpy(buffer + 18, commandAction, strlen(commandAction));
  }
  portEXIT_CRITICAL(&lock);
}

void pcReport(uint8_t *buffer) {
  snprintf(reinterpret_cast<char *>(buffer), hid::kPayloadBytes,
           "agent=%u catalogue=%u", pcAgentOnline(), !needCatalogue.load());
}

void pcReceiveCatalogue(const uint8_t *buffer, uint16_t length) {
  if (length < 5) return;
  const uint16_t offset = buffer[0] | (buffer[1] << 8);
  const uint16_t total = buffer[2] | (buffer[3] << 8);
  if (total == 0 || total > config::kMaxCatalogueBytes || offset >= total) {
    return;
  }
  const uint16_t count = std::min<uint16_t>(length - 4, total - offset);
  portENTER_CRITICAL(&lock);
  if (offset == 0 && !catalogueReady) {
    received = 0;
    expected = total;
  }
  if (!catalogueReady && received == offset && expected == total) {
    memcpy(staging + offset, buffer + 4, count);
    received += count;
    if (received == total) {
      staging[total] = '\0';
      catalogueReady = true;
    }
  }
  portEXIT_CRITICAL(&lock);
}

void pcReceiveResult(const uint8_t *buffer, uint16_t length) {
  if (length < 17) return;
  portENTER_CRITICAL(&lock);
  resultOk = buffer[0] == 1;
  memcpy(resultId, buffer + 1, sizeof(resultId));
  resultReady = true;
  portEXIT_CRITICAL(&lock);
}

bool pcAgentOnline() {
  return polledOnce && millis() - lastPoll.load() < config::kAgentTimeoutMs;
}

bool pcTakeCatalogue(String &json) {
  if (!catalogueReady) return false;
  portENTER_CRITICAL(&lock);
  json = staging;
  catalogueReady = false;
  received = 0;
  expected = 0;
  needCatalogue = false;
  portEXIT_CRITICAL(&lock);
  return true;
}

PcResult pcRun(const char *id, const char *action) {
  uint8_t binaryId[16];
  if (!parseUuid(id, binaryId) || strlen(action) >= sizeof(commandAction)) {
    return PcResult::Failed;
  }
  if (!pcAgentOnline()) {
    return PcResult::Unreachable;
  }
  portENTER_CRITICAL(&lock);
  memcpy(commandId, binaryId, sizeof(commandId));
  snprintf(commandAction, sizeof(commandAction), "%s", action);
  hasCommand = true;
  resultReady = false;
  portEXIT_CRITICAL(&lock);
  PcResult result = PcResult::Unreachable;
  const uint32_t started = millis();
  while (millis() - started < config::kAgentResultTimeoutMs) {
    bool done = false;
    portENTER_CRITICAL(&lock);
    if (resultReady && memcmp(resultId, binaryId, sizeof(resultId)) == 0) {
      result = resultOk ? PcResult::Sent : PcResult::Failed;
      done = true;
    }
    resultReady = false;
    portEXIT_CRITICAL(&lock);
    if (done) break;
    vTaskDelay(pdMS_TO_TICKS(50));
  }
  portENTER_CRITICAL(&lock);
  hasCommand = false;
  portEXIT_CRITICAL(&lock);
  return result;
}
