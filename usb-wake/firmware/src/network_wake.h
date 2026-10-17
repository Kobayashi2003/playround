#pragma once
#include <stdint.h>

void networkBegin();
void networkLoop();
// Safe from any task. Returns 0 when Wi-Fi is down, otherwise a ticket for
// networkWakeFinished().
uint32_t requestNetworkWake();
bool networkWakeFinished(uint32_t ticket, bool *ok);
void networkReport(uint8_t *buffer);
void targetReportInto(uint8_t *buffer);
void receiveNetworkConfig(const uint8_t *buffer, uint16_t length);
void receiveTargetMac(const uint8_t *buffer, uint16_t length);
extern volatile bool networkWakeRequested;
