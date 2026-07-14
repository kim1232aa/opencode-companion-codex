---
name: resume
description: Find the most recent resumable OpenCode task session for a workspace so a follow-up delegation can continue it instead of starting fresh. Use when the user asks to continue, resume, or follow up on the last OpenCode delegation in the same session.
---

# Resume the Last OpenCode Session

When the user wants to continue the previous OpenCode delegation (not start a
fresh one), do this in two steps:

1. Call the `oc_resume_candidate` MCP tool. It returns the most recent resumable
   task session for the workspace as
   `{ available, jobId, opencodeSessionId }`. It is a read-only lookup — it does
   not start or contact a server. Pass `workspace` (absolute path) to target a
   repo other than the server's cwd.

2. If `available` is true, call `oc_delegate` with
   `resumeSession: "<opencodeSessionId>"` and the follow-up task text. That
   continues the same OpenCode session with its prior context.

## Rules

- If `available` is false, there is nothing to resume — start a normal
  `oc_delegate` instead, and tell the user no prior session was found.
- Prefer a fresh delegation with a bounded handoff (objective, current findings,
  constraints, acceptance checks) over resuming unless the user explicitly wants
  the SAME session continued — long resumed sessions carry stale context.
- The `opencodeSessionId` is also printed at the end of every `oc_delegate`
  result, so a resume can use that directly when you already have it.

## Resume vs fresh: decide, do not block

**Never stall waiting for the user to choose.** There is no question tool in a
delegation context, and a dispatch that waits for an answer nobody gives just
hangs until the watchdog kills it. Decide deterministically:

- The user's words are clearly a follow-up ("continue", "keep going", "resume",
  "apply the top fix", "dig deeper") → resume: pass `resumeSession`.
- Anything else → **start fresh. Fresh is the default.**
- If a question tool genuinely IS available in the current context, you may ask
  once instead — but never wait on one that is not there.

When a resumable session existed and you started fresh anyway, say so in one
line with the result, so the user can override:

`Detected a resumable OpenCode session <id>; started a new session. To continue that session instead, ask to resume (or pass resumeSession explicitly).`
