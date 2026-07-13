# opencode-companion-codex

Delegate coding tasks **from Codex to OpenCode** — and through OpenCode, to
**any OpenAI-compatible backend** (a local aggregator, DeepSeek, GLM, Kimi,
Doubao, …). Save your expensive Codex/GPT tokens for the thinking; ship the
routine work to cheap models.

To our knowledge this is the first plugin of its kind: existing delegation
plugins go the other way (Codex → Claude Code, or Claude Code → Codex/OpenCode).
This one completes the square.

```
Codex ──(MCP, blocking)──▶ opencode-companion ──(REST)──▶ opencode serve ──▶ your cheap models
```

## What you get

Nine MCP tools, each with a matching skill that teaches Codex when and how to
use them:

| Tool | What it does |
|---|---|
| `oc_delegate` | Delegate a task and **block until the real result returns** — one MCP call, no polling, up to 7 days. Returns the output, a **one-line token/model/session trailer**, and changed files. |
| `oc_delegate_batch` | Delegate **several independent tasks in parallel** in one call — the host runs MCP tools serially, so batching is the only way to fan out (e.g. to different models). Blocks until all finish, returns every result. |
| `oc_status` | Running/recent jobs with a **live token heartbeat** and the **actual commands OpenCode is running** (`bash:`/`edit:`/`read:` activity lines) — tokens climbing means generating, frozen means stuck. |
| `oc_result` | Fetch a finished job's output — including **recovering the answer of an interrupted run** from the OpenCode server (marked `recovered`). |
| `oc_cancel` | Abort a running job's OpenCode session (never clobbers an already-finished result). Called with **no job ref, it cancels every running job** in the workspace. |
| `oc_review` / `oc_adversarial_review` | **Read-only code review** of the working-tree diff (or a `base` branch diff) on OpenCode, returning structured findings against the review-output schema. The adversarial variant takes a `focus` and tries to break the change rather than validate it. |
| `oc_resume_candidate` | Find the most recent **resumable** task session for the workspace, so you can continue it via `oc_delegate`'s `resumeSession`. |
| `oc_setup` | Check the OpenCode install, server, and configured providers. |

The delegation core is shared with
[opencode-companion-cc](https://github.com/kim1232aa/opencode-companion-cc)
(the Claude Code frontend of the same engine) and inherits its hardening from
five rounds of adversarial multi-model review: PID start-time ownership
fingerprints, a steal-proof file lock, compare-and-set cancel, git-worktree
isolation with failure-preserving apply-back, process-group kills, strict
dispatch-time result filtering (no half-finished or stale answers recovered),
and 0700/0600 private state.

Codex-frontend specifics:
- **Task text never touches argv** — it arrives as structured MCP params, so it
  can't leak through the process list.
- Delegation runs **in-process** in the MCP server: no detached worker to die,
  and MCP's `notifications/cancelled` maps directly to an OpenCode session
  abort.
- State lives in `~/.opencode-companion-codex/` (stable across plugin
  versions; override with `OPENCODE_COMPANION_DATA`).

## Requirements

- [Codex CLI](https://github.com/openai/codex) ≥ 0.144 (the `codex plugin`
  subsystem)
- [OpenCode CLI](https://opencode.ai) installed, with at least one provider
  configured in `~/.config/opencode/opencode.jsonc` — any OpenAI-compatible
  endpoint works
- Node.js ≥ 20

## Install

```bash
codex plugin marketplace add https://github.com/kim1232aa/opencode-companion-codex.git
codex plugin add opencode-companion@opencode-companion-codex
```

Then start a **new** Codex session (plugins don't hot-load into a running one)
and try:

> Delegate to OpenCode: summarize what this repository does. Use model
> `<provider>/<model>`.

## Usage notes

- `agent: "plan"` is the only read-only mode; the default `build` agent has
  full write access.
- For a write task in a repo you're editing concurrently, ask for
  `worktree: true` — OpenCode works in an isolated git worktree and the changes
  are applied back (conflicts are surfaced, never silently clobbered).
- A long delegation (15–30+ min) keeps the single MCP call pending — that's by
  design. If it's ever interrupted, `oc_result` recovers the finished answer.
- `OPENCODE_SERVER_PORT` overrides the OpenCode server port (default 4096) for
  both dispatch and recovery.
- The plugin ships with `default_tools_approval_mode: "approve"` in its
  `.mcp.json` — without it, Codex elicits an approval for every MCP tool call,
  which headless `codex exec` runs auto-cancel (`user cancelled MCP tool
  call`). If you prefer per-call confirmation in the interactive TUI, change it
  to `"prompt"` in the installed plugin's `.mcp.json`. The trade-off is
  documented: these tools only dispatch work to the OpenCode instance you
  yourself configured, and validate all job references.

## Relationship to other projects

| Project | Direction |
|---|---|
| [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Claude Code → Codex |
| [tasict/opencode-plugin-cc](https://github.com/tasict/opencode-plugin-cc) | Claude Code → OpenCode (unmaintained) |
| [kim1232aa/opencode-companion-cc](https://github.com/kim1232aa/opencode-companion-cc) | Claude Code → OpenCode (our hardened engine, shared with this repo) |
| **this repo** | **Codex → OpenCode** |

This is an independent community project, not affiliated with OpenAI or the
OpenCode project. See [NOTICE](NOTICE) for the Apache-2.0 attribution chain of
the shared engine code.

## Development

```bash
npm test          # lib + full MCP protocol handshake + review/trailer/cancel-all
```

For local iteration, install from a checkout:

```bash
codex plugin marketplace add /path/to/opencode-companion-codex
codex plugin add opencode-companion@opencode-companion-codex
```

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
