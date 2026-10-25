// USB HID interface: a boot keyboard (for USB remote wake-up) plus the vendor
// feature report described in hid_protocol.h.
#pragma once
#include <stdint.h>

void usbHidBegin();

extern volatile bool bootloaderRequested;
extern volatile bool wakeRequested;
