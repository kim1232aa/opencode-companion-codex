---
name: status
description: Show running and recent OpenCode delegation jobs, including a live token-progress heartbeat that distinguishes a working run from a stuck one. Use when the user asks how a delegation is going, whether it is stuck, or what OpenCode jobs exist.
---

# OpenCode Job Status

Call the `oc_status` MCP tool and return its output.

- Running jobs show a `heartbeat: N tokens so far` line refreshed every ~30s.
  **Tokens climbing between two calls = the model is generating; frozen across
  several = genuinely stuck.** A quiet log is otherwise normal — it only
  changes on phase transitions.
- Do NOT call this in a loop while an `oc_delegate` call is pending in this
  conversation — that call already blocks until completion. Status is for
  checking on interrupted or background work, or when the user asks.
- This tool also heals state: jobs whose worker died are reconciled, and
  finished answers are recovered from the OpenCode server where possible.
- Judge job liveness ONLY from this tool's output — never by reading the
  plugin's state files or job logs directly.
