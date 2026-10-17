#pragma once
#include <stdint.h>

void beginBootKeyboard();
void fillDiagnosticReport(uint8_t *buffer, uint8_t page);
extern volatile bool downloadRequested;
