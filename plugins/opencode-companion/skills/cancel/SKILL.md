---
name: cancel
description: Cancel a running OpenCode delegation job. Use when the user asks to stop, abort, or kill a delegated OpenCode task.
---

# Cancel an OpenCode Job

Call the `oc_cancel` MCP tool (most recent running job by default, or pass
`job: "<id-or-prefix>"`).

- Cancellation aborts the job's OpenCode session; a job that already finished
  is never overwritten — the tool reports its actual terminal status instead.
- After canceling, `oc_status` confirms the final state. A canceled job's
  partial output is not preserved.
