// Vendor HID protocol shared with tools/board.py; keep the two in sync.
//
// Everything travels in feature report 2 (63 payload bytes). A write whose
// first byte is a command carries that command's data; any other first byte
// selects the page that the next read returns. Pages are NUL-terminated text
// except kPagePoll.
#pragma once
#include <stdint.h>

namespace hid {

constexpr uint8_t kReportId = 2;
constexpr uint16_t kPayloadBytes = 63;

// Read pages.
constexpr uint8_t kPageNetwork = 200;  // Wi-Fi, IP, packets sent
constexpr uint8_t kPageCloud = 201;    // cloud link status
constexpr uint8_t kPageTarget = 202;   // target MAC
constexpr uint8_t kPageBoard = 203;    // temperature, CPU clock, USB state
// Agent poll, binary: [0xA5, flags, command id (16 bytes), action id].
// flags: bit 0 = board wants the action catalogue, bit 1 = command waiting.
constexpr uint8_t kPagePoll = 204;
constexpr uint8_t kPageAgent = 205;  // agent seen, catalogue received

constexpr uint8_t kPollMagic = 0xA5;
constexpr uint8_t kPollNeedCatalogue = 0x01;
constexpr uint8_t kPollHasCommand = 0x02;

// Write commands.
constexpr uint8_t kCommandCatalogue = 250;   // offset, total (LE u16), data
constexpr uint8_t kCommandResult = 251;      // ok byte, command id (16 bytes)
constexpr uint8_t kCommandTargetMac = 252;   // 6 bytes
constexpr uint8_t kCommandWifi = 253;        // offset, total, data
constexpr uint8_t kCommandWake = 254;        // no data
constexpr uint8_t kCommandBootloader = 255;  // no data

}  // namespace hid
