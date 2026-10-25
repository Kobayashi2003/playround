#include "status.h"
#include <Arduino.h>
#include <tusb.h>
#include <atomic>
#include "config.h"
#include "hid_protocol.h"

namespace {
// Sampled in loop(): the sensor driver must not run inside the USB callback.
std::atomic<float> temperature{NAN};
std::atomic<HostPower> settled{HostPower::Off};
std::atomic<bool> known{false};
HostPower candidate = HostPower::Off;
uint32_t candidateSince = 0;
uint32_t lastTemperature = 0;
bool sampled = false;

HostPower rawHostPower() {
  if (tud_suspended()) return HostPower::Sleep;
  return tud_mounted() ? HostPower::On : HostPower::Off;
}
}  // namespace

void statusLoop(uint32_t now) {
  if (!sampled || now - lastTemperature >= config::kTemperatureSampleMs) {
    sampled = true;
    lastTemperature = now;
    temperature = temperatureRead();
  }
  // Enumeration and resume flicker through intermediate states; only a state
  // that holds for kHostSettleMs is reported.
  const HostPower raw = rawHostPower();
  if (raw != candidate) {
    candidate = raw;
    candidateSince = now;
  } else if (now - candidateSince >= config::kHostSettleMs) {
    settled = raw;
    known = true;
  }
}

bool hostPowerKnown() { return known; }

HostPower hostPower() { return settled; }

const char *hostPowerName(HostPower power) {
  switch (power) {
    case HostPower::On:
      return "on";
    case HostPower::Sleep:
      return "sleep";
    default:
      return "off";
  }
}

float chipTemperature() { return temperature; }

void boardReport(uint8_t *buffer) {
  snprintf(reinterpret_cast<char *>(buffer), hid::kPayloadBytes,
           "temp=%.1fC cpu=%luMHz pc=%s", chipTemperature(),
           static_cast<unsigned long>(getCpuFrequencyMhz()),
           hostPowerName(hostPower()));
}
