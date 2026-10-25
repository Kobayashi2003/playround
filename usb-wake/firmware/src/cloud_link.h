// WebSocket link to the Cloudflare relay, run in its own task: receives wake
// and PC commands and reports their results and the PC agent's state.
#pragma once
#include <stdint.h>

void cloudBegin();
void cloudReport(uint8_t *buffer);
