# Known issues / deferred

- **No per-conversation job scoping.** Jobs are scoped per workspace, not per
  Codex conversation: `oc_status`/`oc_result` see every job for the repository,
  from any session. (The Claude Code frontend scopes by session id; Codex
  provides no equivalent ambient id to the MCP server.)
- **Interrupted in-process delegations rely on server-side recovery.** The MCP
  server runs delegations in-process; if Codex kills the server mid-run, the
  OpenCode session keeps running server-side and `oc_status`/`oc_result`
  recover the finished answer — but only while `opencode serve` stays up. If
  the OpenCode server also dies, the result is genuinely lost.
- **`$` cost depends on the backend.** The token-usage line shows a dollar cost
  only when the OpenCode provider reports one; most custom OpenAI-compatible
  gateways report tokens without prices.
- **Worktree isolation snapshots HEAD.** A `worktree: true` run does not see
  uncommitted changes in the live working tree (by design — it isolates from
  them). Commit first if the task needs them.
- **Windows is untested.** Linux/macOS are the developed targets; the PID
  start-time fingerprint is Linux-only (elsewhere it degrades to a bare
  liveness check).
- **Plugin updates need a new Codex session.** After `codex plugin add`
  reinstalls a newer version, running conversations keep the old tools; start
  a fresh session to pick up changes.
