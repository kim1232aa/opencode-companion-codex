// Git utilities for the OpenCode companion.

import { runCommand } from "./process.mjs";

/**
 * Validate a user-supplied git ref (e.g. --base). Rejects anything that could
 * be parsed by git as an OPTION (leading "-") or that isn't a plausible ref, so
 * `--base "--output=/tmp/x"` can't inject flags into the git invocation.
 * @param {string} ref
 * @returns {string} the validated ref
 */
export function assertSafeRef(ref) {
  const r = String(ref).trim();
  if (!r || r.startsWith("-") || !/^[A-Za-z0-9._/^~@{}-]+$/.test(r)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
  }
  return r;
}

/**
 * Run git and throw on failure, so a broken ref / corrupt repo surfaces as an
 * error instead of silently producing an EMPTY diff (which would let a review
 * pass with no context — a false green).
 */
async function gitOrThrow(cwd, args) {
  const { stdout, stderr, exitCode } = await runCommand("git", args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

/**
 * Get the git repository root for a given directory.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getGitRoot(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Get the current branch name.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getCurrentBranch(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Get the diff for review, supporting base-branch and working-tree modes.
 * Working-tree mode diffs against HEAD so STAGED changes are included —
 * plain `git diff` shows only unstaged edits, which made a staged-only
 * change set review as "no changes".
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function getDiff(cwd, opts = {}) {
  const args = ["diff"];
  if (opts.base) {
    args.push(`${assertSafeRef(opts.base)}...HEAD`);
  } else if (opts.cached) {
    args.push("--cached");
  } else {
    args.push("HEAD"); // staged + unstaged vs HEAD
  }
  return gitOrThrow(cwd, args);
}

/**
 * Get git status (short format).
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function getStatus(cwd) {
  return (await gitOrThrow(cwd, ["status", "--short", "--untracked-files=all"])).trim();
}

/**
 * Get the list of changed files (staged + unstaged in working-tree mode).
 * @param {string} cwd
 * @param {{ base?: string }} opts
 * @returns {Promise<string[]>}
 */
export async function getChangedFiles(cwd, opts = {}) {
  const args = ["diff", "--name-only"];
  if (opts.base) {
    args.push(`${assertSafeRef(opts.base)}...HEAD`);
  } else {
    args.push("HEAD");
  }
  const stdout = await gitOrThrow(cwd, args);
  return stdout.trim().split("\n").filter(Boolean);
}
