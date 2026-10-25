// Hands PC actions from the cloud task to tools/agent.py, which polls the
// board over USB (hid::kPagePoll) and answers with hid::kCommandResult.
#pragma once
#include <Arduino.h>
#include <stdint.h>

enum class PcResult { Sent, Failed, Unreachable };

// USB task side.
void pcPoll(uint8_t *buffer);
void pcReport(uint8_t *buffer);
void pcReceiveCatalogue(const uint8_t *buffer, uint16_t length);
void pcReceiveResult(const uint8_t *buffer, uint16_t length);

// Cloud task side.
bool pcAgentOnline();
// Returns true once per newly received catalogue (a JSON array).
bool pcTakeCatalogue(String &json);
// Blocks until the agent accepts or rejects the command, or times out.
PcResult pcRun(const char *commandId, const char *action);
