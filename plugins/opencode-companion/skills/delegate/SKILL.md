---
name: delegate
description: Delegate a coding task from Codex to OpenCode running on a cheap OpenAI-compatible backend, blocking until the real result returns. Use when the user asks to hand work to OpenCode, offload routine implementation/investigation to a cheaper model, or run a task on a specific provider model.
---

# Delegate to OpenCode

Call the `oc_delegate` MCP tool with the task text. The call BLOCKS until the
OpenCode run finishes and returns the full result plus a token-usage line.

**Two or more independent tasks? Use `oc_delegate_batch` in ONE call** — the host
runs MCP tools sequentially, so several `oc_delegate` calls execute one-by-one;
`oc_delegate_batch` runs the whole array in parallel server-side and returns every
result (each with its own token line and resumable session). Give each entry a
short `label`. For multiple WRITE tasks on the same repository, set
`worktree: true` on each so they can't trample each other.

## Iron rules

- **One call is the whole delegation.** While `oc_delegate` is pending, do not
  sleep, do not poll `oc_status`, do not emit periodic "still waiting" turns, and
  never emulate the delegation through shell commands. Long tasks (15–30+ minutes)
  are normal; the MCP call simply stays pending.
- **The task text must be self-contained.** OpenCode sees only that text plus the
  repository — restate every constraint, path, and acceptance criterion the
  conversation established. Forward user task text verbatim; never summarize or
  "tighten" it.
- **The run is UNATTENDED — a question kills it.** Nobody is on the other end: if
  the model stops to ask, the run hangs until the watchdog kills it, the retry
  hangs the same way, and the spend is wasted. A mid-run question is a *prompt
  bug*. Never write text that invites one ("let me know if…", "confirm before
  proceeding"). When the request has any ambiguity, append the ready-made block
  from [references/unattended-run.md](references/unattended-run.md).
- **Write vs read-only**: `agent: "build"` (default) has full write access;
  `agent: "plan"` is the ONLY read-only mode. Choose `plan` only when the user
  explicitly wants no changes ("review only", "don't modify anything") — an
  investigative-sounding request is not by itself read-only.
- **Never read `~/.local/share/opencode/auth.json` or any credential/token file to
  enumerate providers.** Run `oc_setup` — or `opencode models`. Those are the only
  two supported ways. Model-ref rules (the FIRST-slash split, provider ids,
  auto-prefixing): [references/model-and-credentials.md](references/model-and-credentials.md).
- **Concurrent-edit safety**: for a write task in a repo someone may be editing
  concurrently, set `worktree: true` — OpenCode works in an isolated git worktree
  and the changes are applied back at the end.
- **Follow-ups**: prefer a fresh delegation with a bounded handoff (objective,
  current findings, constraints, acceptance checks) over resuming. Pass
  `resumeSession` only when the user explicitly wants the same OpenCode session
  continued; its id is printed at the end of every result. If a resumable session
  exists but the user did not clearly ask to continue, **start fresh** (the
  default) and say so in one line — never stall waiting for a choice nobody is
  there to make.

## If the call is interrupted

The run usually keeps going server-side. Use `oc_result` to recover the finished
answer (it is marked `recovered`); check `oc_status` first to see live
token-progress heartbeats. Never conclude the work is lost without trying
`oc_result`.
