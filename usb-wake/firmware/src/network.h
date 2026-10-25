// Wi-Fi connection, Wake-on-LAN bursts and the stored target MAC.
#pragma once
#include <stdint.h>

void networkBegin();
// Runs in loop(); sends any requested packets.
void networkLoop();
// Safe from any task. Returns 0 when Wi-Fi is down, otherwise a ticket for
// networkWakeFinished().
uint32_t requestNetworkWake();
bool networkWakeFinished(uint32_t ticket, bool *ok);

// USB task side.
void receiveWifiConfig(const uint8_t *buffer, uint16_t length);
void receiveTargetMac(const uint8_t *buffer, uint16_t length);
void networkReport(uint8_t *buffer);
void targetReport(uint8_t *buffer);
