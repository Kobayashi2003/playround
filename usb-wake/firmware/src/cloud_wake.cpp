#include <Arduino.h>
#include "cloud_wake.h"

#if __has_include("cloud_settings.h")
#include "cloud_settings.h"
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_websocket_client.h>
#include <time.h>
#include <atomic>
#include "network_wake.h"

namespace {
constexpr uint32_t kPingMs = 20000;
// The relay answers "ping" without waking; silence this long means the TCP
// link is half-open, which the client's own reconnect would never notice.
constexpr uint32_t kSilenceMs = 50000;
constexpr size_t kMessageSize = 512;
struct Message {
  char data[kMessageSize];
};
struct CommandRecord {
  char id[37];
  char result[7];
};

Preferences state;
String lastHandled;
String lastResult;
String socketUri;
String socketHeaders;
char report[63] = "waiting-wifi";
portMUX_TYPE reportLock = portMUX_INITIALIZER_UNLOCKED;
QueueHandle_t inbox = nullptr;
esp_websocket_client_handle_t socket = nullptr;
std::atomic<bool> connected{false};
std::atomic<bool> helloNeeded{false};
std::atomic<uint32_t> lastHeard{0};

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

void sendText(const char *text, size_t length) {
  if (connected &&
      esp_websocket_client_send_text(socket, text, length,
                                     pdMS_TO_TICKS(5000)) < 0) {
    setStatus("send-failed");
  }
}

// Tells the relay what was handled last; it replies with any command the
// board has not yet acknowledged.
void sendState() {
  JsonDocument body;
  body["lastHandled"] = lastHandled;
  if (!lastResult.isEmpty()) body["lastResult"] = lastResult;
  char text[128];
  const size_t length = serializeJson(body, text, sizeof(text));
  sendText(text, length);
}

void onSocketEvent(void *, esp_event_base_t, int32_t eventId, void *raw) {
  const auto *event = static_cast<esp_websocket_event_data_t *>(raw);
  if (eventId == WEBSOCKET_EVENT_CONNECTED) {
    lastHeard = millis();
    connected = true;
    helloNeeded = true;
    setStatus("online");
  } else if (eventId == WEBSOCKET_EVENT_DISCONNECTED ||
             eventId == WEBSOCKET_EVENT_CLOSED) {
    connected = false;
    setStatus("reconnecting");
  } else if (eventId == WEBSOCKET_EVENT_DATA) {
    lastHeard = millis();
    if (event->op_code != 0x01 ||
        (event->data_len == 4 && memcmp(event->data_ptr, "pong", 4) == 0)) {
      return;
    }
    if (event->payload_offset != 0 || event->data_len != event->payload_len ||
        event->data_len >= static_cast<int>(kMessageSize)) {
      setStatus("message-too-large");
      return;
    }
    Message message{};
    memcpy(message.data, event->data_ptr, event->data_len);
    if (xQueueSend(inbox, &message, 0) != pdTRUE) {
      setStatus("inbox-full");
    }
  }
}

void handleMessage(const char *text) {
  JsonDocument data;
  if (deserializeJson(data, text) || data["protocol"].as<int>() != 1) {
    setStatus("invalid-response");
    return;
  }
  const char *id = data["command"]["id"] | "";
  if (!*id) {
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
    sendState();
    return;
  }
  // Persist before sending. A reset must never replay an old wake command.
  lastHandled = id;
  lastResult = "failed";
  if (!persistCommand()) {
    setStatus("persist-failed");
    sendState();
    return;
  }
  bool ok = false;
  if (const uint32_t ticket = requestNetworkWake()) {
    const uint32_t started = millis();
    while (!networkWakeFinished(ticket, &ok) && millis() - started < 2000) {
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
  lastResult = ok ? "sent" : "failed";
  persistCommand();
  setStatus(ok ? "wake-packets-sent" : "wake-send-failed");
  sendState();
}

bool startSocket() {
  esp_websocket_client_config_t config{};
  config.uri = socketUri.c_str();
  config.cert_pem = WAKE_CA_CERT;
  config.headers = socketHeaders.c_str();
  config.user_agent = "USB-Wake/2.0";
  config.task_stack = 10240;
  // Liveness is judged by application pings, which the relay can answer
  // while hibernating; protocol pings only keep NAT mappings warm.
  config.ping_interval_sec = 60;
  config.disable_pingpong_discon = true;
  config.keep_alive_enable = true;
  socket = esp_websocket_client_init(&config);
  if (!socket) {
    return false;
  }
  esp_websocket_register_events(socket, WEBSOCKET_EVENT_ANY, onSocketEvent,
                                nullptr);
  return esp_websocket_client_start(socket) == ESP_OK;
}

void cloudTask(void *) {
  uint32_t lastPing = 0;
  Message message;
  for (;;) {
    if (!socket) {
      if (WiFi.status() != WL_CONNECTED) {
        setStatus("waiting-wifi");
      } else if (time(nullptr) < 1700000000) {
        setStatus("waiting-clock-sync");
      } else if (!startSocket()) {
        setStatus("socket-init-failed");
      } else {
        setStatus("connecting");
        continue;
      }
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    if (xQueueReceive(inbox, &message, pdMS_TO_TICKS(200)) == pdTRUE) {
      handleMessage(message.data);
    }
    if (!connected) {
      continue;
    }
    const uint32_t now = millis();
    if (helloNeeded.exchange(false)) {
      lastPing = now;
      sendState();
    }
    if (now - lastPing >= kPingMs) {
      lastPing = now;
      sendText("ping", 4);
    }
    if (now - lastHeard.load() >= kSilenceMs) {
      setStatus("silent-reconnecting");
      connected = false;
      esp_websocket_client_stop(socket);
      esp_websocket_client_start(socket);
    }
  }
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
  String base = WAKE_CLOUD_URL;
  if (base.startsWith("https://")) {
    base = "wss://" + base.substring(8);
  }
  socketUri = base + "/device/socket";
  socketHeaders = String("Authorization: Bearer ") + WAKE_DEVICE_TOKEN + "\r\n";
  configTime(0, 0, "ntp.aliyun.com", "time.cloudflare.com", "pool.ntp.org");
  inbox = xQueueCreate(4, sizeof(Message));
  // Its own task: TLS handshakes must never stall the button, LED or USB.
  xTaskCreatePinnedToCore(cloudTask, "cloud", 8192, nullptr, 1, nullptr, 1);
}

void cloudReport(uint8_t *buffer) {
  portENTER_CRITICAL(&reportLock);
  memcpy(buffer, report, sizeof(report));
  portEXIT_CRITICAL(&reportLock);
}
#else
void cloudBegin() {}
void cloudReport(uint8_t *buffer) {
  memset(buffer, 0, 63);
  strcpy(reinterpret_cast<char *>(buffer), "not-configured");
}
#endif
