// Over-the-air updates from the relay (tools/ota.py uploads them).
//
// A new image boots on probation: unless it reaches the relay within
// config::kOtaConfirmMs, the bootloader returns to the previous image.
#pragma once
#include <stdint.h>

void otaBegin();
// Hex SHA-256 of the running image, as tools/ota.py and the relay name it.
const char *otaRunningDigest();
// UTC build time stamped by firmware/version.py.
const char *otaBuild();
// Call once the relay has answered; ends the probation of a new image.
void otaConfirm();
// Runs in the cloud task; rolls back an image whose probation ran out.
void otaLoop();
// Downloads, verifies and installs the offered image, then restarts.
// Returns only on failure, with a short reason for the cloud status page.
const char *otaInstall(const char *digest, uint32_t size);
