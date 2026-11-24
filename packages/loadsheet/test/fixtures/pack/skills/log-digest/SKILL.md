---
name: log-digest
description: >-
  Reads a long application log and groups its errors by cause, with the first and last time
  each one happened, how often it repeated, which requests it touched, and the stack frame most
  likely at fault. Use when someone pastes a log, points at a log file, asks why a service is
  failing, or wants a summary of what went wrong overnight.
when_to_use: A log file or pasted log output is in the conversation.
---

# Log digest

1. Split the log into entries.
2. Group entries by error type and message template.
3. Report each group with its count, first and last timestamp, and the most likely frame.
