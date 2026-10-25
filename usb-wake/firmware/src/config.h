// Firmware tunables. Change values here, rebuild and flash; nothing else in
// src/ should hard-code these. Cloud endpoint, device token and CA bundle live
// in the generated cloud_settings.h instead (see README, "Deploy").
#pragma once
#include <WiFi.h>
#include <stdint.h>

namespace config {

// ---- Power and heat -------------------------------------------------------

// CPU clock in MHz. 80 is the lowest the Wi-Fi driver allows and is plenty for
// this firmware; 160 or 240 only shorten TLS handshakes and run hotter.
constexpr uint32_t kCpuFrequencyMhz = 80;

// Wi-Fi power save. WIFI_PS_MIN_MODEM lets the radio doze between router
// beacons (adds roughly 0.1-0.3 s latency); WIFI_PS_NONE keeps it fully awake
// and is the main source of heat.
constexpr wifi_ps_type_t kWifiPowerSave = WIFI_PS_MIN_MODEM;

// Transmit power. 8.5 dBm suits a board near the router; step up
// (WIFI_POWER_11dBm, 13dBm, 15dBm ... 19_5dBm) if the link becomes unreliable.
constexpr wifi_power_t kWifiTxPower = WIFI_POWER_8_5dBm;

// Main loop pause in ms. Longer saves a little power but slows button and LED.
constexpr uint32_t kLoopDelayMs = 5;

// ---- Wi-Fi ----------------------------------------------------------------

constexpr const char *kHostname = "usb-wake";

// Restart a stuck association after this long without a connection.
constexpr uint32_t kWifiRetryMs = 30000;

// ---- Wake-on-LAN ----------------------------------------------------------

// Used until `tools/status.py --target-mac` stores another adapter.
constexpr uint8_t kDefaultTargetMac[6] = {0x58, 0x11, 0x22, 0xAB, 0x1C, 0xC8};

// Each wake sends a short burst of magic packets to the subnet broadcast.
constexpr uint16_t kWakePort = 9;
constexpr uint8_t kWakePacketCount = 3;
constexpr uint32_t kWakePacketGapMs = 150;

// ---- Cloud link -----------------------------------------------------------

// Sent with every relay connection; bump it with protocol changes.
constexpr const char *kUserAgent = "USB-Wake/3.2";

// Application ping interval; the relay answers without waking up.
constexpr uint32_t kCloudPingMs = 20000;

// Reconnect when nothing has been heard for this long (half-open TCP link).
constexpr uint32_t kCloudSilenceMs = 50000;

// WebSocket protocol ping interval in seconds; only keeps NAT mappings warm.
constexpr int kSocketProtocolPingSec = 60;

// Stack for the WebSocket task, which performs the TLS handshake.
constexpr int kSocketTaskStack = 10240;

// WebSocket frame buffer. Must hold a whole state message, including the PC
// action catalogue (kMaxCatalogueBytes) plus its JSON envelope.
constexpr int kSocketBufferSize = 2048;

// Stack for the task that handles commands; it also runs the OTA download's
// TLS handshake.
constexpr uint32_t kCloudTaskStack = 12288;

// Board health and PC power are resent at least this often.
constexpr uint32_t kTelemetryMs = 60000;

// How long a cloud command waits for its packet burst before reporting.
constexpr uint32_t kWakeResultTimeoutMs = 2000;

// Commands promising a longer lifetime than this are rejected as invalid.
constexpr uint64_t kMaxCommandLifetimeMs = 30000;

// Clock must be synced before TLS can validate certificates.
constexpr const char *kNtpServers[3] = {"ntp.aliyun.com", "time.cloudflare.com",
                                        "pool.ntp.org"};

// ---- PC agent -------------------------------------------------------------

// The agent polls about once a second; this long without a poll means the PC
// is asleep, off, or the agent is not running.
constexpr uint32_t kAgentTimeoutMs = 5000;

// How long a PC action waits for the agent to accept it before the board
// reports it as unreachable. Must stay well under the 30 s command lifetime.
constexpr uint32_t kAgentResultTimeoutMs = 10000;

// Largest action catalogue (compact JSON) the agent may send. tools/agent.py
// enforces the same limit.
constexpr uint16_t kMaxCatalogueBytes = 1024;

// ---- Firmware updates -----------------------------------------------------

// A newly installed image must reach the relay within this long after boot,
// or the bootloader returns to the previous image.
constexpr uint32_t kOtaConfirmMs = 5 * 60 * 1000;

// The download is abandoned after this long without any data.
constexpr uint32_t kOtaStallMs = 20000;

// A failed download of the same image is retried after this long.
constexpr uint32_t kOtaRetryMs = 10 * 60 * 1000;

// ---- Board ----------------------------------------------------------------

// USB must hold a state this long before the PC's power change is reported;
// enumeration and resume pass through brief intermediate states.
constexpr uint32_t kHostSettleMs = 3000;

constexpr uint8_t kButtonPin = 0;
constexpr uint8_t kLedPin = 21;
constexpr uint32_t kButtonDebounceMs = 35;

// How often the on-chip temperature sensor is sampled for `tools/status.py`.
// It reads the die, so expect several degrees above the board surface.
constexpr uint32_t kTemperatureSampleMs = 5000;

// How long the LED shows the result of a wake attempt.
constexpr uint32_t kWakeFeedbackMs = 1200;

// LED brightness steps offered on the web page, as channel levels (0-255).
// Kept low: the RGB LED is bright and adds heat. The names are the protocol
// values; cloud/src/state.js lists the same ones.
constexpr uint8_t kLedLevelCount = 4;
constexpr const char *kLedNames[kLedLevelCount] = {"off", "low", "medium",
                                                   "high"};
constexpr uint8_t kLedLevels[kLedLevelCount] = {0, 3, 8, 24};
// Used until the page picks another level.
constexpr uint8_t kLedDefault = 2;

// ---- USB identity ---------------------------------------------------------

constexpr const char *kUsbProduct = "USB Wake Boot Keyboard";
constexpr const char *kUsbManufacturer = "Personal USB Wake";
// tools/board.py finds the board by this serial; change both together. A new
// serial also stops Windows reusing cached descriptors after a USB change.
constexpr const char *kUsbSerial = "S3ZERO-WAKE-BOOT03";

}  // namespace config
