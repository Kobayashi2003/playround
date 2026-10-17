#pragma once
#include <stdint.h>

void networkBegin();
void networkLoop();
bool requestNetworkWake();
void networkReport(uint8_t *buffer);
void receiveNetworkConfig(const uint8_t *buffer, uint16_t length);
extern volatile bool networkWakeRequested;
uint32_t networkSentCount();
bool networkLastSendSucceeded();
