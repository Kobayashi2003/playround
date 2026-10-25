#include <Arduino.h>
#include <USB.h>
#include <esp32-hal-rgb-led.h>
#include <esp32-hal-tinyusb.h>
#include <tusb.h>
#include "cloud_link.h"
#include "config.h"
#include "led.h"
#include "network.h"
#include "ota.h"
#include "status.h"
#include "usb_hid.h"

namespace {
bool previousRaw = false;
bool stablePressed = false;
uint32_t buttonChangedAt = 0;
uint32_t feedbackUntil = 0;
bool feedbackOk = false;

// Local wake from the BOOT button or `status.py --wake`: Wake-on-LAN, plus a
// USB remote wake-up when the host has suspended this keyboard.
void wakeLocally() {
  const bool usbAccepted = tud_suspended() && tud_remote_wakeup();
  feedbackOk = requestNetworkWake() != 0 || usbAccepted;
  feedbackUntil = millis() + config::kWakeFeedbackMs;
}

void updateLed(uint32_t now) {
  const uint8_t level = ledLevel();
  if (static_cast<int32_t>(feedbackUntil - now) > 0) {
    // Brighter than the idle colours: green when sent, purple when not. Shown
    // even with the LED off, so a button press is always confirmed.
    const uint8_t flash = max(level, config::kLedLevels[1]) * 3 / 2;
    neopixelWrite(config::kLedPin, feedbackOk ? 0 : flash,
                  feedbackOk ? flash : 0, feedbackOk ? 0 : flash);
  } else if (tud_suspended()) {
    neopixelWrite(config::kLedPin, 0, 0, (now / 500) % 2 ? level : 0);
  } else if (tud_mounted()) {
    neopixelWrite(config::kLedPin, 0, level, 0);
  } else {
    neopixelWrite(config::kLedPin, level, level / 2, 0);
  }
}
}  // namespace

void setup() {
  setCpuFrequencyMhz(config::kCpuFrequencyMhz);
  otaBegin();
  ledBegin();
  pinMode(config::kButtonPin, INPUT_PULLUP);
  USB.productName(config::kUsbProduct);
  USB.manufacturerName(config::kUsbManufacturer);
  USB.serialNumber(config::kUsbSerial);
  USB.usbClass(0);
  USB.usbSubClass(0);
  USB.usbProtocol(0);
  USB.usbAttributes(0xA0);  // Bus powered, remote wake-up capable.
  USB.usbPower(500);
  usbHidBegin();
  USB.begin();
  networkBegin();
  cloudBegin();
}

void loop() {
  const uint32_t now = millis();
  networkLoop();
  if (wakeRequested) {
    wakeRequested = false;
    wakeLocally();
  }
  const bool rawPressed = digitalRead(config::kButtonPin) == LOW;
  if (rawPressed != previousRaw) {
    previousRaw = rawPressed;
    buttonChangedAt = now;
  }
  if (now - buttonChangedAt >= config::kButtonDebounceMs &&
      stablePressed != rawPressed) {
    stablePressed = rawPressed;
    if (stablePressed) {
      wakeLocally();
    }
  }
  if (bootloaderRequested) {
    delay(100);
    usb_persist_restart(RESTART_BOOTLOADER);
  }
  statusLoop(now);
  static uint32_t lastLedUpdate = 0;
  if (now - lastLedUpdate >= 100) {
    lastLedUpdate = now;
    updateLed(now);
  }
  delay(config::kLoopDelayMs);
}
