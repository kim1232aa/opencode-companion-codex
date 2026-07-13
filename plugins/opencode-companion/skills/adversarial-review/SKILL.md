---
name: adversarial-review
description: Run a read-only adversarial code review on OpenCode — the reviewer actively tries to break confidence in the change and returns a terse ship/no-ship verdict with structured findings. Use before merging risky changes, or when the user wants a skeptical "what could go wrong" pass rather than a neutral review.
---

# Adversarial Review on OpenCode

Call the `oc_adversarial_review` MCP tool and return its output. The call BLOCKS
until the review finishes and returns the rendered verdict, findings, and a
token-usage line.

The reviewer defaults to skepticism and hunts for expensive, hard-to-detect
failures — auth and trust boundaries, data loss/corruption, rollback and
idempotency gaps, race conditions, version skew, and observability holes — then
returns an `approve` / `needs-attention` verdict.

- **Scope**: reviews the working-tree changes by default; pass
  `base: "<branch-or-ref>"` to review a branch diff instead.
- **Focus**: pass `focus: "<area>"` (e.g. `"the migration path"`,
  `"concurrency"`) to weight a specific concern heavily. It still reports any
  other material issue it can defend.
- **Read-only**: runs on OpenCode's `plan` agent — never edits the repository.
- **Model / Workspace**: same as `oc_review` — `model` is `<providerID>/<modelID>`
  (first-slash split), `workspace` is an absolute repo path.

## Rules

- **One call is the whole review.** Do not poll or emit waiting turns while it
  is pending.
- Return the tool output as-is, including the verdict and token-usage line.
  Treat `needs-attention` as a real blocking signal worth surfacing plainly.
- This is a tracked job (visible via `oc_status` / `oc_result`); an interrupted
  run may be recoverable via `oc_result`.
