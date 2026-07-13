---
name: review
description: Run a read-only code review of a workspace's changes on OpenCode (a cheap OpenAI-compatible backend), blocking until it returns structured findings. Use when the user asks to review the current diff, review changes before a commit, or offload a routine review to a cheaper model.
---

# Review Changes on OpenCode

Call the `oc_review` MCP tool and return its output. The call BLOCKS until the
review finishes and returns the rendered findings plus a token-usage line.

- **Scope**: by default it reviews the workspace's uncommitted working-tree
  changes (staged and unstaged). Pass `base: "<branch-or-ref>"` (e.g. `"main"`)
  to review the branch diff against that base instead.
- **Read-only**: the review runs on OpenCode's `plan` agent and never edits the
  repository. It is safe to run on a dirty tree.
- **Model**: pass `model` as `<providerID>/<modelID>` (split on the FIRST
  slash). Omit for the provider default. Run `oc_setup` to list provider IDs.
- **Workspace**: pass `workspace` (absolute path) to review a repo other than
  the server's cwd.

## Rules

- **One call is the whole review.** While `oc_review` is pending, do not sleep,
  poll `oc_status`, or emit "still waiting" turns — the MCP call simply stays
  pending until the review returns.
- Return the tool output as-is, including the trailing token-usage line. The
  findings are already rendered — do not re-summarize unless asked.
- The review is also a tracked job: `oc_status` / `oc_result` can show it, and
  an interrupted run may be recoverable via `oc_result`.
- For an adversarial "try to break it" review with a ship/no-ship verdict, use
  the `oc_adversarial_review` tool instead.
