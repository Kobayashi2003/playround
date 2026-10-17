#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <algorithm>
#include "network_wake.h"

volatile bool networkWakeRequested = false;
namespace {
// Wired adapter of the target PC, read locally on 2026-10-15.
constexpr uint8_t targetMac[] = {0x58, 0x11, 0x22, 0xAB, 0x1C, 0xC8};
Preferences settings;
WiFiUDP udp;
String ssid;
String password;
uint8_t configStaging[98]{};
uint8_t receivedBytes = 0;
uint8_t expectedBytes = 0;
volatile bool configReady = false;
portMUX_TYPE configLock = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE reportLock = portMUX_INITIALIZER_UNLOCKED;
char report[61] = "cfg=0 up=0 ip=0.0.0.0 tx=0 ok=0";
uint32_t lastConnect = 0;
uint32_t sentPackets = 0;
uint32_t nextPacket = 0;
uint8_t remainingPackets = 0;
bool lastSendOk = false;
uint32_t lastReport = 0;

void connectWifi() {
  lastConnect = millis();
  WiFi.begin(ssid.c_str(), password.c_str());
}

void sendPacket() {
  uint8_t packet[102];
  memset(packet, 0xFF, 6);
  for (size_t i = 0; i < 16; ++i) {
    memcpy(packet + 6 + i * 6, targetMac, 6);
  }
  IPAddress broadcast;
  const IPAddress local = WiFi.localIP();
  const IPAddress mask = WiFi.subnetMask();
  for (size_t i = 0; i < 4; ++i) {
    broadcast[i] = local[i] | static_cast<uint8_t>(~mask[i]);
  }
  lastSendOk = false;
  if (udp.beginPacket(broadcast, 9)) {
    const size_t written = udp.write(packet, sizeof(packet));
    lastSendOk = udp.endPacket() == 1 && written == sizeof(packet);
    if (lastSendOk) {
      ++sentPackets;
    }
  }
}
}  // namespace

void networkBegin() {
  settings.begin("wifi-wake", false);
  ssid = settings.getString("ssid");
  password = settings.getString("password");
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("usb-wake");
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  if (!ssid.isEmpty()) {
    connectWifi();
  }
}

void receiveNetworkConfig(const uint8_t *buffer, uint16_t length) {
  if (length < 3) {
    return;
  }
  const uint8_t offset = buffer[0];
  const uint8_t total = buffer[1];
  if (total < 3 || total > sizeof(configStaging) || offset >= total) {
    return;
  }
  const uint16_t count = std::min<uint16_t>(length - 2, total - offset);
  portENTER_CRITICAL(&configLock);
  if (offset == 0 && !configReady) {
    receivedBytes = 0;
    expectedBytes = total;
  }
  if (!configReady && receivedBytes == offset && expectedBytes == total) {
    memcpy(configStaging + offset, buffer + 2, count);
    receivedBytes += count;
    configReady = receivedBytes == total;
  }
  portEXIT_CRITICAL(&configLock);
}

bool requestNetworkWake() {
  if (WiFi.status() != WL_CONNECTED) {
    lastSendOk = false;
    return false;
  }
  remainingPackets = 3;
  nextPacket = millis();
  return true;
}

uint32_t networkSentCount() { return sentPackets; }
bool networkLastSendSucceeded() { return lastSendOk; }

void networkReport(uint8_t *buffer) {
  memset(buffer, 0, 63);
  portENTER_CRITICAL(&reportLock);
  memcpy(buffer, report, sizeof(report));
  portEXIT_CRITICAL(&reportLock);
}

void networkLoop() {
  const uint32_t now = millis();
  if (configReady) {
    uint8_t data[98];
    uint8_t total;
    portENTER_CRITICAL(&configLock);
    total = expectedBytes;
    memcpy(data, configStaging, sizeof(data));
    memset(configStaging, 0, sizeof(configStaging));
    configReady = false;
    receivedBytes = 0;
    expectedBytes = 0;
    portEXIT_CRITICAL(&configLock);
    const uint8_t ssidLength = data[0];
    const uint8_t passwordLength = data[1];
    if (ssidLength >= 1 && ssidLength <= 32 && passwordLength <= 63 &&
        total == 2 + ssidLength + passwordLength) {
      char newSsid[33]{};
      char newPassword[64]{};
      memcpy(newSsid, data + 2, ssidLength);
      memcpy(newPassword, data + 2 + ssidLength, passwordLength);
      ssid = newSsid;
      password = newPassword;
      settings.putString("ssid", ssid);
      settings.putString("password", password);
      WiFi.disconnect();
      connectWifi();
      memset(newPassword, 0, sizeof(newPassword));
    }
    memset(data, 0, sizeof(data));
  }
  if (!ssid.isEmpty() && WiFi.status() != WL_CONNECTED &&
      now - lastConnect >= 20000) {
    connectWifi();
  }
  if (remainingPackets && static_cast<int32_t>(now - nextPacket) >= 0) {
    if (WiFi.status() == WL_CONNECTED) {
      sendPacket();
      --remainingPackets;
      nextPacket = now + 150;
    } else {
      remainingPackets = 0;
      lastSendOk = false;
    }
  }
  if (now - lastReport >= 500) {
    lastReport = now;
    char value[61];
    snprintf(value, sizeof(value), "cfg=%u up=%u ip=%s tx=%lu ok=%u",
             !ssid.isEmpty(), WiFi.status() == WL_CONNECTED,
             WiFi.localIP().toString().c_str(),
             static_cast<unsigned long>(sentPackets), lastSendOk);
    portENTER_CRITICAL(&reportLock);
    memcpy(report, value, sizeof(report));
    portEXIT_CRITICAL(&reportLock);
  }
}
