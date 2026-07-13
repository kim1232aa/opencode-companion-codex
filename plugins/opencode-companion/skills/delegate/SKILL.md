---
name: delegate
description: Delegate a coding task from Codex to OpenCode running on a cheap OpenAI-compatible backend, blocking until the real result returns. Use when the user asks to hand work to OpenCode, offload routine implementation/investigation to a cheaper model, or run a task on a specific provider model.
---

# Delegate to OpenCode

Call the `oc_delegate` MCP tool with the task text. The call BLOCKS until the
OpenCode run finishes and returns the full result plus a token-usage line.

**Two or more independent tasks? Use `oc_delegate_batch` in ONE call** — the
host runs MCP tools sequentially, so issuing several `oc_delegate` calls
executes them one-by-one; `oc_delegate_batch` runs the whole array in parallel
server-side and returns every result (each with its own token line and
resumable session). Give each entry a short `label`. For multiple WRITE tasks
touching the same repository, set `worktree: true` on each so they can't
trample each other.

## Rules

- **One call is the whole delegation.** While `oc_delegate` is pending, do not
  sleep, do not poll `oc_status`, do not emit periodic "still waiting" turns,
  and never emulate the delegation through shell commands. Long tasks
  (15–30+ minutes) are normal; the MCP call simply stays pending.
- **The task text must be self-contained.** OpenCode sees only that text plus
  the repository — restate every constraint, path, and acceptance criterion
  the conversation established. Forward user task text verbatim; do not
  summarize or "tighten" it.
- **Write vs read-only**: `agent: "build"` (default) has full write access;
  `agent: "plan"` is the ONLY read-only mode. Choose `plan` only when the user
  explicitly wants no changes ("review only", "don't modify anything") — an
  investigative-sounding request is not by itself read-only.
- **Model**: pass `model` as `provider/model` only when the user names one
  (model ids may contain further slashes — pass the full ref unchanged).
- **Concurrent-edit safety**: for a write task in a repo someone may be editing
  concurrently, set `worktree: true` — OpenCode works in an isolated git
  worktree and the changes are applied back at the end.
- **Follow-ups**: prefer a fresh delegation with a bounded handoff (objective,
  current findings, constraints, acceptance checks) over resuming. Pass
  `resumeSession` only when the user explicitly wants the same OpenCode
  session continued; its id is printed at the end of every result.

## If the call is interrupted

The run usually keeps going server-side. Use `oc_result` to recover the
finished answer (it is marked `recovered`); check `oc_status` to see live
token-progress heartbeats first. Never conclude the work is lost without
trying `oc_result`.
