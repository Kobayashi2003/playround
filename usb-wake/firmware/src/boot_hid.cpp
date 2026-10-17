#include <Arduino.h>
#include <esp32-hal-tinyusb.h>
#include <tusb.h>
#include "boot_hid.h"
#include "network_wake.h"

namespace {
uint8_t pageRequested = 0;
const uint8_t reportDescriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(1)),
    0x06, 0x00, 0xFF,  // Vendor usage page 0xFF00.
    0x09, 0x01,        // Diagnostic collection, accessible separately on Windows.
    0xA1, 0x01,
    0x85, 0x02,        // Feature report ID 2, 63 payload bytes.
    0x09, 0x01,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x3F,
    0xB1, 0x02,
    0xC0};

uint16_t loadInterface(uint8_t *destination, uint8_t *interfaceNumber) {
  const uint8_t endpoint = tinyusb_get_free_in_endpoint();
  if (!endpoint) {
    return 0;
  }
  const uint8_t descriptor[] = {
      TUD_HID_DESCRIPTOR(*interfaceNumber,
                         tinyusb_add_string_descriptor("Boot Keyboard"),
                         HID_ITF_PROTOCOL_KEYBOARD, sizeof(reportDescriptor),
                         static_cast<uint8_t>(0x80 | endpoint), 16, 10)};
  ++*interfaceNumber;
  memcpy(destination, descriptor, sizeof(descriptor));
  return sizeof(descriptor);
}
}  // namespace

void beginBootKeyboard() {
  ESP_ERROR_CHECK(tinyusb_enable_interface(USB_INTERFACE_HID,
                                          TUD_HID_DESC_LEN, loadInterface));
}

extern "C" uint8_t const *tud_hid_descriptor_report_cb(uint8_t) {
  return reportDescriptor;
}

extern "C" uint16_t tud_hid_get_report_cb(uint8_t, uint8_t reportId,
                                         hid_report_type_t type,
                                         uint8_t *buffer, uint16_t length) {
  if (reportId == 2 && type == HID_REPORT_TYPE_FEATURE && length >= 63) {
    fillDiagnosticReport(buffer, pageRequested);
    return 63;
  }
  if (type == HID_REPORT_TYPE_INPUT && length >= 8) {
    memset(buffer, 0, 8);
    return 8;
  }
  return 0;
}

extern "C" void tud_hid_set_report_cb(uint8_t, uint8_t reportId,
                                      hid_report_type_t type,
                                      const uint8_t *buffer, uint16_t length) {
  if (reportId == 2 && type == HID_REPORT_TYPE_FEATURE && length) {
    if (buffer[0] == 255) {
      downloadRequested = true;
    } else if (buffer[0] == 254) {
      networkWakeRequested = true;
    } else if (buffer[0] == 253) {
      receiveNetworkConfig(buffer + 1, length - 1);
    } else {
      pageRequested = buffer[0];
    }
  }
}
