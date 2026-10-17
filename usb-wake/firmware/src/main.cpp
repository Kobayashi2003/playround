#include <Arduino.h>
#include <Preferences.h>
#include <USB.h>
#include <esp32-hal-rgb-led.h>
#include <esp32-hal-tinyusb.h>
#include <esp_system.h>
#include <tusb.h>
#include "boot_hid.h"
#include "network_wake.h"
#include "cloud_wake.h"

constexpr uint8_t kButton = 0;
constexpr uint8_t kLed = 21;
constexpr size_t kEventCapacity = 24;
bool previousRaw = false;
bool stablePressed = false;
uint32_t buttonChangedAt = 0;
uint32_t feedbackUntil = 0;
uint32_t attempts = 0;
bool lastWakeAccepted = false;
volatile bool remoteWakeAllowed = false;
volatile bool downloadRequested = false;
Preferences diagnostics;
struct WakeSnapshot {
  uint32_t boot;
  uint32_t atMs;
  uint8_t mounted;
  uint8_t suspended;
  uint8_t allowed;
  uint8_t accepted;
};
WakeSnapshot lastPress{};
uint32_t bootCount = 0;
struct UsbEvent {
  uint32_t atMs;
  int32_t id;
  bool allowed;
};
UsbEvent events[kEventCapacity]{};
size_t eventCount = 0;
portMUX_TYPE eventLock = portMUX_INITIALIZER_UNLOCKED;

void recordEvent(int32_t id, bool allowed) {
  portENTER_CRITICAL(&eventLock);
  events[eventCount % kEventCapacity] = {millis(), id, allowed};
  ++eventCount;
  portEXIT_CRITICAL(&eventLock);
}

void onUsbEvent(void *, esp_event_base_t, int32_t eventId, void *eventData) {
  if (eventId == ARDUINO_USB_SUSPEND_EVENT) {
    const auto *data = static_cast<arduino_usb_event_data_t *>(eventData);
    remoteWakeAllowed = data->suspend.remote_wakeup_en;
  } else if (eventId == ARDUINO_USB_RESUME_EVENT ||
             eventId == ARDUINO_USB_STOPPED_EVENT) {
    remoteWakeAllowed = false;
  }
  recordEvent(eventId, remoteWakeAllowed);
}

void writeU32(uint8_t *buffer, size_t offset, uint32_t value) {
  memcpy(buffer + offset, &value, sizeof(value));
}

void fillDiagnosticReport(uint8_t *buffer, uint8_t page) {
  if (page == 200) {
    networkReport(buffer);
    return;
  }
  if (page == 201) {
    cloudReport(buffer);
    return;
  }
  if (page == 202) {
    targetReportInto(buffer);
    return;
  }
  memset(buffer, 0, 63);
  buffer[0] = 5;
  buffer[1] = tud_mounted();
  buffer[2] = tud_suspended();
  buffer[3] = remoteWakeAllowed;
  buffer[4] = lastWakeAccepted;
  buffer[5] = static_cast<uint8_t>(esp_reset_reason());
  buffer[6] = page;
  writeU32(buffer, 8, millis());
  writeU32(buffer, 12, bootCount);
  writeU32(buffer, 16, attempts);
  writeU32(buffer, 20, lastPress.boot);
  writeU32(buffer, 24, lastPress.atMs);
  buffer[28] = lastPress.mounted;
  buffer[29] = lastPress.suspended;
  buffer[30] = lastPress.allowed;
  buffer[31] = lastPress.accepted;
  portENTER_CRITICAL(&eventLock);
  const size_t available = min(eventCount, kEventCapacity);
  const size_t first = eventCount - available;
  buffer[7] = available;
  writeU32(buffer, 32, eventCount);
  for (size_t i = 0; i < 2; ++i) {
    const size_t relative = static_cast<size_t>(page) * 2 + i;
    if (relative < available) {
      const UsbEvent &event = events[(first + relative) % kEventCapacity];
      const size_t offset = 36 + i * 12;
      writeU32(buffer, offset, event.atMs);
      writeU32(buffer, offset + 4, static_cast<uint32_t>(event.id));
      buffer[offset + 8] = event.allowed;
    }
  }
  portEXIT_CRITICAL(&eventLock);
}

void requestWake() {
  ++attempts;
  lastWakeAccepted = false;
  lastPress = {bootCount, millis(), tud_mounted(), tud_suspended(),
               remoteWakeAllowed, false};
  if (tud_suspended()) {
    lastWakeAccepted = tud_remote_wakeup();
  }
  lastPress.accepted = lastWakeAccepted;
  diagnostics.putBytes("press", &lastPress, sizeof(lastPress));
  recordEvent(100, lastPress.allowed);
  requestNetworkWake();
  feedbackUntil = millis() + 1200;
}

void setup() {
  pinMode(kButton, INPUT_PULLUP);
  diagnostics.begin("wake-diag", false);
  bootCount = diagnostics.getUInt("boots", 0) + 1;
  diagnostics.putUInt("boots", bootCount);
  if (diagnostics.getBytesLength("press") == sizeof(lastPress)) {
    diagnostics.getBytes("press", &lastPress, sizeof(lastPress));
  }
  USB.productName("USB Wake Boot Keyboard");
  USB.manufacturerName("Personal USB Wake");
  // A new serial avoids reusing Windows' cached composite-device descriptors.
  USB.serialNumber("S3ZERO-WAKE-BOOT03");
  USB.usbClass(0);
  USB.usbSubClass(0);
  USB.usbProtocol(0);
  USB.usbAttributes(0xA0);
  USB.usbPower(500);
  USB.onEvent(onUsbEvent);
  beginBootKeyboard();
  USB.begin();
  networkBegin();
  cloudBegin();
}

void loop() {
  const uint32_t now = millis();
  networkLoop();
  if (networkWakeRequested) {
    networkWakeRequested = false;
    requestWake();
  }
  const bool rawPressed = digitalRead(kButton) == LOW;
  if (rawPressed != previousRaw) {
    previousRaw = rawPressed;
    buttonChangedAt = now;
  }
  if (now - buttonChangedAt >= 35 && stablePressed != rawPressed) {
    stablePressed = rawPressed;
    if (stablePressed) {
      requestWake();
    }
  }
  if (downloadRequested) {
    delay(100);
    usb_persist_restart(RESTART_BOOTLOADER);
  }
  static uint32_t lastLedUpdate = 0;
  if (now - lastLedUpdate >= 100) {
    lastLedUpdate = now;
    if (static_cast<int32_t>(feedbackUntil - now) > 0) {
      neopixelWrite(kLed, lastWakeAccepted ? 0 : 12,
                    lastWakeAccepted ? 12 : 0, lastWakeAccepted ? 0 : 12);
    } else if (tud_suspended()) {
      neopixelWrite(kLed, 0, 0, (now / 500) % 2 ? 8 : 0);
    } else if (tud_mounted()) {
      neopixelWrite(kLed, 0, 8, 0);
    } else {
      neopixelWrite(kLed, 8, 4, 0);
    }
  }
  delay(5);
}
