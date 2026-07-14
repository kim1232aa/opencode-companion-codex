---
name: resume
description: Find the most recent resumable OpenCode task session for a workspace so a follow-up delegation can continue it instead of starting fresh. Use when the user asks to continue, resume, or follow up on the last OpenCode delegation in the same session.
---

# Resume the Last OpenCode Session

1. Call `oc_resume_candidate` — a read-only lookup (it starts nothing and contacts
   no server) returning `{ available, jobId, opencodeSessionId }`. Pass `workspace`
   (absolute path) to target a repo other than the server's cwd.
2. If `available` is true, call `oc_delegate` with
   `resumeSession: "<opencodeSessionId>"` plus the follow-up task text — that
   continues the same OpenCode session with its prior context.

The `opencodeSessionId` is also printed at the end of every `oc_delegate` result, so
use it directly when you already have it. If `available` is false, there is nothing
to resume — run a normal `oc_delegate` and tell the user no prior session was found.

## Resume vs fresh: decide, do not block

**Never stall waiting for the user to choose.** There is no question tool in a
delegation context, and a dispatch that waits for an answer nobody gives just hangs
until the watchdog kills it. Decide deterministically:

- The user's words are clearly a follow-up ("continue", "keep going", "resume",
  "apply the top fix", "dig deeper") → resume: pass `resumeSession`.
- Anything else → **start fresh. Fresh is the default.** Prefer a fresh delegation
  with a bounded handoff (objective, current findings, constraints, acceptance
  checks) — long resumed sessions carry stale context.
- If a question tool genuinely IS available, you may ask once instead — but never
  wait on one that is not there.

When a resumable session existed and you started fresh anyway, say so in one line
with the result, so the user can override:

`Detected a resumable OpenCode session <id>; started a new session. To continue that session instead, ask to resume (or pass resumeSession explicitly).`
