---
name: result
description: Fetch the final output of a finished OpenCode delegation, including recovering the answer of a run whose connection was interrupted. Use when the user asks for a delegation's outcome, when an oc_delegate call was cut off, or before concluding that a result was lost.
---

# OpenCode Job Result

Call the `oc_result` MCP tool (newest finished job by default, or pass
`job: "<id-or-prefix>"`).

- **Interrupted runs are usually recoverable.** If a delegation's connection
  died after dispatch, the OpenCode session typically finished server-side;
  this tool salvages that answer and marks it with the line
  `> Recovered from the OpenCode server after the worker exited without returning.`
  When you see that marker, mention the recovery and sanity-check the answer
  looks complete.
- "No finished job yet" with a job still running means wait or check
  `oc_status` (watch its token heartbeat) — do not re-dispatch the same task.
- Return the tool output as the result, including the trailing token-usage
  line and the session id (useful for an explicit resume).
