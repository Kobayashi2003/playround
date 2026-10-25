#include "usb_hid.h"
#include <Arduino.h>
#include <esp32-hal-tinyusb.h>
#include <tusb.h>
#include "cloud_link.h"
#include "hid_protocol.h"
#include "network.h"
#include "pc_link.h"
#include "status.h"

volatile bool bootloaderRequested = false;
volatile bool wakeRequested = false;

namespace {
// Shared by every reader; a tool that switches pages between another tool's
// write and read gets the wrong page, which agent.py detects by kPollMagic.
volatile uint8_t pageRequested = hid::kPageNetwork;

const uint8_t reportDescriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(1)),
    0x06, 0x00, 0xFF,  // Vendor page 0xFF00: its own HID device on Windows.
    0x09, 0x01,
    0xA1, 0x01,
    0x85, hid::kReportId,
    0x09, 0x01,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, hid::kPayloadBytes,
    0xB1, 0x02,  // Feature report.
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

void fillPage(uint8_t *buffer, uint8_t page) {
  memset(buffer, 0, hid::kPayloadBytes);
  switch (page) {
    case hid::kPageNetwork:
      networkReport(buffer);
      break;
    case hid::kPageCloud:
      cloudReport(buffer);
      break;
    case hid::kPageTarget:
      targetReport(buffer);
      break;
    case hid::kPageBoard:
      boardReport(buffer);
      break;
    case hid::kPagePoll:
      pcPoll(buffer);
      break;
    case hid::kPageAgent:
      pcReport(buffer);
      break;
  }
}
}  // namespace

void usbHidBegin() {
  ESP_ERROR_CHECK(tinyusb_enable_interface(USB_INTERFACE_HID,
                                          TUD_HID_DESC_LEN, loadInterface));
}

extern "C" uint8_t const *tud_hid_descriptor_report_cb(uint8_t) {
  return reportDescriptor;
}

extern "C" uint16_t tud_hid_get_report_cb(uint8_t, uint8_t reportId,
                                         hid_report_type_t type,
                                         uint8_t *buffer, uint16_t length) {
  if (reportId == hid::kReportId && type == HID_REPORT_TYPE_FEATURE &&
      length >= hid::kPayloadBytes) {
    fillPage(buffer, pageRequested);
    return hid::kPayloadBytes;
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
  if (reportId != hid::kReportId || type != HID_REPORT_TYPE_FEATURE ||
      !length) {
    return;
  }
  const uint8_t *data = buffer + 1;
  const uint16_t size = length - 1;
  switch (buffer[0]) {
    case hid::kCommandBootloader:
      bootloaderRequested = true;
      break;
    case hid::kCommandWake:
      wakeRequested = true;
      break;
    case hid::kCommandWifi:
      receiveWifiConfig(data, size);
      break;
    case hid::kCommandTargetMac:
      receiveTargetMac(data, size);
      break;
    case hid::kCommandResult:
      pcReceiveResult(data, size);
      break;
    case hid::kCommandCatalogue:
      pcReceiveCatalogue(data, size);
      break;
    default:
      pageRequested = buffer[0];
  }
}
