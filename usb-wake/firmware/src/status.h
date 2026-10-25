// Board health and the PC's power state as seen over USB.
#pragma once
#include <stdint.h>

// From the USB link: mounted = on, suspended = asleep, gone = off (or the
// port is unpowered, in which case the board is off too).
enum class HostPower : uint8_t { On, Sleep, Off };

// Runs in loop(): samples the temperature and settles the host power state.
void statusLoop(uint32_t now);
// False until the state has held for kHostSettleMs once after boot.
bool hostPowerKnown();
HostPower hostPower();
const char *hostPowerName(HostPower power);
float chipTemperature();
// Text for hid::kPageBoard.
void boardReport(uint8_t *buffer);
