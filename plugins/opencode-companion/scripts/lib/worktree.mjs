// Optional git-worktree isolation for write-mode tasks.
//
// OpenCode's `build` agent snapshots its workspace (git) for undo. If we run it
// directly in a live repo while other edits are happening, its snapshot/restore
// can revert unrelated concurrent changes. Running it in a throwaway worktree
// keeps its snapshots inside that worktree; we then apply the resulting patch
// back to the real repo (surfacing a conflict instead of silently clobbering).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";

async function git(cwd, args, opts = {}) {
  // A total timeout so a wedged git (e.g. blocked on a held index.lock) can't
  // hang the worker indefinitely; callers may override via opts.timeoutMs.
  return runCommand("git", args, { cwd, timeoutMs: 120_000, ...opts });
}

async function isGitRepo(dir) {
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  return !!r && r.exitCode === 0 && r.stdout.trim() === "true";
}

async function repoToplevel(dir) {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => null);
  return r && r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * Run `fn(effectiveCwd)` — either directly in `dir`, or, when isolation is
 * requested and possible, inside a fresh detached git worktree whose changes
 * are applied back to `dir` afterward and then removed.
 *
 * @param {object} o
 * @param {string} o.dir           the task workspace
 * @param {string} o.jobId
 * @param {boolean} o.useWorktree  --worktree was requested
 * @param {boolean} o.isWrite      write-capable run (isolation only matters here)
 * @param {(cwd: string) => Promise<any>} fn
 * @param {(msg: string) => void} [log]
 * @returns {Promise<any>} whatever fn returns
 */
export async function withWorktree({ dir, jobId, useWorktree, isWrite }, fn, log = () => {}) {
  if (!useWorktree || !isWrite || !(await isGitRepo(dir))) {
    if (useWorktree && isWrite) log("--worktree ignored: not inside a git repository.");
    return fn(dir);
  }

  const top = (await repoToplevel(dir)) || dir;
  // Sanitize jobId before it becomes a path segment (defense-in-depth; ids are
  // generated safe, but never let one traverse out of the worktrees dir).
  const safeJob = path.basename(String(jobId)) || "job";
  const wtParent = path.join(top, ".opencode-worktrees");
  const wtPath = path.join(wtParent, safeJob);

  const add = await git(top, ["worktree", "add", "--detach", wtPath, "HEAD"]);
  if (add.exitCode !== 0) {
    // The caller EXPLICITLY asked for isolation; silently running in the live
    // workspace would defeat exactly what --worktree exists to prevent. Fail.
    throw new Error(`--worktree setup failed: ${add.stderr.trim() || "git worktree add failed"}. Not falling back to the live workspace (isolation was explicitly requested).`);
  }

  // The worktree starts detached at the repo's current HEAD. Pin that SHA now: if
  // the agent runs `git commit` inside the worktree, HEAD moves forward, and
  // capturing the changes with a diff against the LITERAL "HEAD" ref would then
  // compare against the agent's OWN commit — yielding an empty patch and silently
  // dropping the committed work when the worktree is removed. Diff against the
  // pinned base instead, so committed + staged + unstaged changes are all caught.
  const rp = await git(top, ["rev-parse", "HEAD"]).catch(() => null);
  const baseRef = rp && rp.exitCode === 0 && rp.stdout.trim() ? rp.stdout.trim() : "HEAD";

  // If `dir` was a subdirectory of the repo, run the task in the matching
  // subdirectory INSIDE the worktree — not the worktree root — so OpenCode's
  // cwd and visible file scope match what the caller asked for.
  const rel = path.relative(top, dir);
  const effectiveCwd =
    rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(wtPath, rel) : wtPath;

  let patchFile = null;
  let keepWorktree = false;
  try {
    let result;
    try {
      result = await fn(effectiveCwd);
    } catch (err) {
      // The task itself failed (HTTP timeout, API error, …) AFTER it may have
      // already modified files in the worktree. Removing the worktree now would
      // silently destroy those changes — keep it and point the user at it.
      keepWorktree = true;
      log(`Task failed inside the isolated worktree; its partial changes are preserved at ${wtPath}.`);
      throw err;
    }

    // Capture everything the task changed in the worktree as one patch.
    // Check exit codes: a failed add/diff (index.lock, disk full, corrupt repo)
    // would otherwise yield an empty patch and SILENTLY discard the task's
    // changes when the worktree is removed below.
    const added = await git(wtPath, ["add", "-A"]);
    if (added.exitCode !== 0) {
      keepWorktree = true;
      throw new Error(`git add -A failed in worktree (${added.stderr.trim() || "unknown error"}); changes preserved at ${wtPath}.`);
    }
    const MAX_PATCH = 128 * 1024 * 1024;
    const diff = await git(wtPath, ["diff", "--cached", "--binary", baseRef], { maxOutputBytes: MAX_PATCH });
    if (diff.exitCode !== 0) {
      keepWorktree = true;
      throw new Error(`git diff failed in worktree (${diff.stderr.trim() || "unknown error"}); changes preserved at ${wtPath}.`);
    }
    const patch = diff.stdout || "";

    // A truncated diff would corrupt the patch and apply garbage — refuse it.
    if (diff.overflowed) {
      keepWorktree = true;
      // The task ran, but its changes could NOT be applied back. Returning
      // `result` here would report the delegation COMPLETE while the changes sit
      // stranded in the worktree — a false success. Fail honestly and point at
      // where the work is (oc_result can still recover the model's answer text).
      throw new Error(`Task changes exceed ${Math.round(MAX_PATCH / (1024 * 1024))}MB and were NOT applied back to the workspace. Recover them from the preserved worktree at ${wtPath}.`);
    }

    if (patch.trim()) {
      // runCommand cannot feed stdin (stdio[0] === "ignore"), so `git apply -`
      // would read nothing. Write the patch to a temp file and apply from it.
      patchFile = path.join(os.tmpdir(), `opencode-wt-${safeJob}.patch`);
      // 0600: the patch is the task's full source diff, sitting in the shared
      // tmpdir — same owner-only policy as the state/result files. Remove any
      // stale same-named file first: writeFileSync applies `mode` only on
      // CREATION, so a leftover 0644 file from an old run would keep its mode.
      try { fs.unlinkSync(patchFile); } catch { /* none */ }
      fs.writeFileSync(patchFile, patch, { mode: 0o600 });
      const apply = await runCommand("git", ["-C", top, "apply", "--whitespace=nowarn", patchFile])
        .catch((e) => ({ exitCode: 1, stderr: e.message, stdout: "" }));
      if (apply.exitCode !== 0) {
        keepWorktree = true;
        // Applying back failed (typically a conflict with concurrent edits).
        // Don't report the task complete with its changes silently stranded —
        // fail, and preserve both the patch and the worktree for recovery.
        throw new Error(`Task changes could NOT be applied back to the workspace (likely a conflict with concurrent edits): ${apply.stderr.trim()}. The patch is preserved at ${patchFile} and the worktree at ${wtPath}.`);
      }
      log("Applied the isolated worktree changes back to the workspace.");
    }
    return result;
  } finally {
    if (patchFile && !keepWorktree) {
      try { fs.unlinkSync(patchFile); } catch { /* best-effort */ }
    }
    // Leave the worktree in place when apply failed/overflowed so the user can recover.
    if (!keepWorktree) {
      const rm = await git(top, ["worktree", "remove", "--force", wtPath])
        .catch((e) => ({ exitCode: 1, stderr: e.message }));
      if (rm.exitCode !== 0) {
        log(`Warning: could not remove worktree ${wtPath} (${(rm.stderr || "").trim() || "unknown error"}); it may need manual cleanup via 'git worktree remove'.`);
      } else {
        // Remove the now-empty parent dir (best-effort; fails harmlessly if
        // other concurrent worktrees still live under it).
        try { fs.rmdirSync(wtParent); } catch { /* not empty or gone — fine */ }
      }
    }
  }
}
