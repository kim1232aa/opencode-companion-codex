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
    let stdout = "";
    let stderr = "";
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
    const signalTree = (sig) => {
      try {
        if (useGroup && proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        /* already gone */
      }
    };
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
            stdout += d.subarray(0, remaining).toString();
            stdoutBytes += remaining;
          }
          escalateKill();
          return;
        }
        stdout += d;
        stdoutBytes += d.length;
        return;
      }
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      if (settled || overflowed) return;
      if (maxOutputBytes !== undefined) {
        if (stderrBytes + d.length > maxOutputBytes) {
          overflowed = true;
          const remaining = Math.max(0, maxOutputBytes - stderrBytes);
          if (remaining > 0) {
            stderr += d.subarray(0, remaining).toString();
            stderrBytes += remaining;
          }
          escalateKill();
          return;
        }
        stderr += d;
        stderrBytes += d.length;
        return;
      }
      stderr += d;
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
      const result = { stdout, stderr, exitCode: exitCode ?? 1 };
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
