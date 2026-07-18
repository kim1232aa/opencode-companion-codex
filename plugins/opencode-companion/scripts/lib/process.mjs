// Process utilities for the OpenCode companion.

import { spawn } from "node:child_process";

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  return new Promise((resolve) => {
    const proc = spawn("which", ["opencode"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    proc.stdout.on("data", (d) => {
      if (!settled) out += d;
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      console.error(`Failed to resolve opencode binary: ${err.message}`);
      resolve(null);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

/**
 * Check if `opencode` CLI is available.
 * @returns {Promise<boolean>}
 */
export async function isOpencodeInstalled() {
  const bin = await resolveOpencodeBinary();
  return bin !== null;
}

/**
 * Get the installed opencode version.
 * @returns {Promise<string|null>}
 */
export async function getOpencodeVersion() {
  return new Promise((resolve) => {
    const proc = spawn("opencode", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    let settled = false;
    proc.stdout.on("data", (d) => {
      if (!settled) out += d;
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      console.error(`Failed to get opencode version: ${err.message}`);
      resolve(null);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

/**
 * Signal a detached child's whole process GROUP (POSIX), or just the process
 * itself when we don't own a group (Windows, or `group: false`). Swallows the
 * "already gone" (ESRCH) / "not signalable" (EPERM) races so a kill that loses a
 * race with the process's own exit is never fatal.
 *
 * This is the single home of the `process.kill(-pid, …)` group-signal dance:
 * runCommand's timeout/overflow kills AND the foreground cancel path both go
 * through here instead of open-coding the negative-pid trick and its try/catch.
 *
 * @param {number|undefined} pid - the group leader's pid (its PGID equals its pid)
 * @param {NodeJS.Signals|number} sig
 * @param {{ group?: boolean }} [opts]
 */
export function signalGroup(pid, sig, { group = true } = {}) {
  if (!pid) return;
  try {
    if (group && process.platform !== "win32") process.kill(-pid, sig);
    else process.kill(pid, sig);
  } catch {
    /* already gone (ESRCH) or not signalable by us (EPERM) */
  }
}

/**
 * SIGTERM a detached worker's process GROUP, wait up to `graceMs` for it to
 * exit, then SIGKILL any survivor — the SAME TERM→KILL escalation runCommand
 * uses for its own children, but AWAITABLE, so a caller (the `x`/Ctrl-C cancel
 * path) can block until the worker has exited — or, once SIGKILL is sent, until
 * the kernel has had a tick to reap it — before it exits itself. It does NOT
 * promise the pid is provably gone: a process wedged in uninterruptible sleep
 * (D state) can still probe alive after SIGKILL, which is why the return value
 * carries an honest `alive` flag rather than asserting death.
 * (runCommand's own escalation is fire-and-forget via a timer, which a signal
 * handler cannot use: once the handler calls process.exit the timer never fires.)
 *
 * Liveness is checked with the injected `isAlive` predicate; the companion
 * passes an OWNERSHIP-aware one so a recycled pid is never mistaken for the
 * worker. It defaults to a bare `process.kill(pid, 0)` probe.
 *
 * @param {number} pid
 * @param {{ graceMs?: number, pollMs?: number, group?: boolean,
 *           isAlive?: (pid: number) => boolean }} [opts]
 * @returns {Promise<{ signaled: boolean, escalated: boolean, alive: boolean }>}
 */
export async function terminateGroup(pid, opts = {}) {
  const { graceMs = 2000, pollMs = 100, group = true } = opts;
  const isAlive = opts.isAlive ?? ((p) => {
    try { process.kill(p, 0); return true; } catch (err) { return err.code === "EPERM"; }
  });

  if (!pid || !isAlive(pid)) return { signaled: false, escalated: false, alive: false };

  signalGroup(pid, "SIGTERM", { group });

  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { signaled: true, escalated: false, alive: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!isAlive(pid)) return { signaled: true, escalated: false, alive: false };

  // Still alive after the grace period — a child that ignores SIGTERM (or left
  // grandchildren holding on) can't wedge us open. Escalate.
  signalGroup(pid, "SIGKILL", { group });
  await new Promise((r) => setTimeout(r, pollMs)); // let the kernel reap it
  return { signaled: true, escalated: true, alive: isAlive(pid) };
}

/**
 * Run a command and return { stdout, stderr, exitCode }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // detached: run the child in its OWN process group (POSIX) so timeout /
    // overflow kills can signal the WHOLE group (-pid). Killing only the direct
    // child leaves grandchildren (e.g. `sh -c "sleep 100"`) holding the output
    // pipes, and `close` never fires — wedging the caller open.
    const useGroup = process.platform !== "win32";
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: useGroup,
    });
    // Accumulate raw Buffer chunks and decode ONCE at settle time. The old
    // `str += chunk` coerced每个 chunk 单独 toString():a multibyte UTF-8 char
    // split across a stream read boundary (~64KiB) decoded to U+FFFD pairs —
    // which silently corrupted large CJK diffs captured for the worktree
    // writeback, and `git apply` then applied the corrupted patch with exit 0.
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let overflowed = false;
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutputBytes =
      typeof opts.maxOutputBytes === "number" && opts.maxOutputBytes >= 0
        ? opts.maxOutputBytes
        : undefined;
    const timeoutMs =
      typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;

    let killTimer = null;
    let graceTimer = null;
    // Signal the whole process group when we own one, else just the child.
    // Goes through the shared signalGroup so the negative-pid dance lives once.
    const signalTree = (sig) => signalGroup(proc.pid, sig, { group: useGroup });
    // SIGTERM, then SIGKILL after a short grace — so a child that ignores
    // SIGTERM (or leaves grandchildren holding the pipe) can't wedge us open.
    const escalateKill = () => {
      signalTree("SIGTERM");
      graceTimer = setTimeout(() => signalTree("SIGKILL"), 2000);
      graceTimer.unref?.();
    };

    if (timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true;
        escalateKill();
      }, timeoutMs);
      killTimer.unref?.();
    }

    proc.stdout.on("data", (d) => {
      if (settled || overflowed) return;
      if (maxOutputBytes !== undefined) {
        if (stdoutBytes + d.length > maxOutputBytes) {
          overflowed = true;
          const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
          if (remaining > 0) {
            stdoutChunks.push(d.subarray(0, remaining));
            stdoutBytes += remaining;
          }
          escalateKill();
          return;
        }
        stdoutChunks.push(d);
        stdoutBytes += d.length;
        return;
      }
      stdoutChunks.push(d);
    });
    proc.stderr.on("data", (d) => {
      if (settled || overflowed) return;
      if (maxOutputBytes !== undefined) {
        if (stderrBytes + d.length > maxOutputBytes) {
          overflowed = true;
          const remaining = Math.max(0, maxOutputBytes - stderrBytes);
          if (remaining > 0) {
            stderrChunks.push(d.subarray(0, remaining));
            stderrBytes += remaining;
          }
          escalateKill();
          return;
        }
        stderrChunks.push(d);
        stderrBytes += d.length;
        return;
      }
      stderrChunks.push(d);
    });
    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new Error(`Failed to spawn command '${cmd}': ${err.message}`));
    });
    proc.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Single decode over the concatenated bytes — chunk boundaries can no
      // longer split a multibyte character. (An overflow cut can still land
      // mid-character at the very end, but overflow is an honest error path.)
      const result = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: exitCode ?? 1,
      };
      if (maxOutputBytes !== undefined) {
        result.overflowed = overflowed;
      }
      if (timeoutMs !== undefined) {
        result.timedOut = timedOut;
      }
      resolve(result);
    });
  });
}

/**
 * Spawn a detached background process.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  child.on("error", (err) => {
    console.error(`Failed to spawn detached command '${cmd}': ${err.message}`);
  });
  child.unref();
  return child;
}
