---
name: status
description: Show running and recent OpenCode delegation jobs, including a live token-progress heartbeat that distinguishes a working run from a stuck one. Use when the user asks how a delegation is going, whether it is stuck, or what OpenCode jobs exist.
---

# OpenCode Job Status

Call the `oc_status` MCP tool and return its output. It is a multi-job
dashboard — read every section, not just the first.

Judge each job's state from the dashboard, not from token motion alone:
- 🟢 **running** shows a live token count and `updated Ns ago`. **Tokens higher
  than the previous check = generating.** Same tokens with a large "updated …
  ago" (the tool flags `⚠️ possibly stuck` past ~2 min) = stuck, not done.
- ❌ **Failed** jobs are surfaced at the TOP with their error — a mid-run error
  no longer hides at the bottom while you watch the runners.
- ✅ **completed** = finished with output. **`⚠️ no output` = finished but the
  model returned nothing usable — that is NOT success.** Treat it like a
  failure: try a different `model` or rephrase.
- Token motion tells you "alive", not "succeeded" — always confirm the final
  state and that output exists.
- Do NOT call this in a loop while an `oc_delegate` call is pending in this
  conversation — that call already blocks until completion. Status is for
  checking on interrupted or background work, or when the user asks.
- This tool also heals state: jobs whose worker died are reconciled, and
  finished answers are recovered from the OpenCode server where possible.
- Judge job liveness ONLY from this tool's output — never by reading the
  plugin's state files or job logs directly.
