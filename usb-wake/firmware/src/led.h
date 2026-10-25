#pragma once
#include <stdint.h>

// LED brightness chosen on the web page, kept in NVS across restarts.
void ledBegin();
// Applies a level by name ("off", "low", "medium", "high"); returns true only
// when the level changed.
bool ledSet(const char *name);
const char *ledName();
// Channel level (0-255) for the idle colours.
uint8_t ledLevel();
