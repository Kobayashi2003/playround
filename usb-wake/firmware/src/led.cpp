#include "led.h"
#include <Preferences.h>
#include <string.h>
#include <atomic>
#include "config.h"

namespace {
Preferences settings;
// Set from the cloud task, read by loop().
std::atomic<uint8_t> current{config::kLedDefault};
}  // namespace

void ledBegin() {
  settings.begin("led", false);
  const uint8_t stored = settings.getUChar("level", config::kLedDefault);
  if (stored < config::kLedLevelCount) current = stored;
}

bool ledSet(const char *name) {
  for (uint8_t i = 0; i < config::kLedLevelCount; ++i) {
    if (strcmp(name, config::kLedNames[i]) != 0) continue;
    if (current.exchange(i) == i) return false;
    settings.putUChar("level", i);
    return true;
  }
  return false;
}

const char *ledName() { return config::kLedNames[current]; }

uint8_t ledLevel() { return config::kLedLevels[current]; }
