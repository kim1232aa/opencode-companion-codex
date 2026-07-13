// Filesystem utilities for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";

/**
 * Ensure a directory exists (recursive mkdir), private to the current user.
 * State can land in a shared location (/tmp fallback), and job results/logs may
 * contain code and review output — 0700 keeps other local users out.
 * @param {string} dirPath
 */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

/**
 * Read a JSON file, returning null on failure.
 * @param {string} filePath
 * @returns {any|null}
 */
export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write a JSON file atomically (write to tmp then rename).
 * @param {string} filePath
 * @param {any} data
 */
export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Append a line to a file.
 * @param {string} filePath
 * @param {string} line
 */
export function appendLine(filePath, line) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * Read the last N lines of a file.
 * @param {string} filePath
 * @param {number} n
 * @returns {string[]}
 */
export function tailLines(filePath, n = 10) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Read a process's kernel start-time (jiffies since boot, field 22 of
 * /proc/<pid>/stat) as an ownership fingerprint: two processes that share a pid
 * but have different start-times are NOT the same process. Linux-only; returns
 * null when /proc is unavailable/unreadable (non-Linux, or the pid is gone).
 * @param {number} pid
 * @returns {string|null}
 */
export function pidStartTime(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) is parenthesized and may contain spaces/parens; split on
    // the LAST ")" so the remaining fields align to their numbers.
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return null;
    const rest = stat.slice(rparen + 2).split(" ");
    const starttime = rest[19]; // field 22 (state is field 3 ⇒ rest[0])
    return starttime && /^\d+$/.test(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

// A held lock is only reclaimed when its owner process is provably gone (dead,
// OR a pid recycled by an unrelated process — detected via the start-time
// fingerprint in the owner token). It is NEVER reclaimed on mtime age while the
// original holder is provably still alive, which would steal the lock from a
// slow-but-alive holder and break mutual exclusion. The mtime fallback is a
// last resort ONLY for locks we cannot fingerprint: a token that can't be read
// (crash mid-write / foreign pre-token lock) or a live pid we can't fingerprint
// (non-Linux). It is deliberately long, since a healthy critical section here
// is milliseconds.
const LOCK_STALE_FALLBACK_MS = 60_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerFile(lockPath) {
  return path.join(lockPath, "owner");
}

function readLockOwner(lockPath) {
  try {
    return fs.readFileSync(lockOwnerFile(lockPath), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Classify a lock owner token of the form `pid:start:nonce` (start may be "0"
 * when the holder couldn't be fingerprinted).
 * @returns {{ alive: boolean, fingerprinted: boolean }}
 *   alive — is the ORIGINAL holder still running (dead OR recycled ⇒ false);
 *   fingerprinted — was that judgment backed by a start-time match (⇒ trust it
 *   absolutely and ignore age) vs a bare liveness guess (⇒ age fallback applies).
 */
function ownerLiveState(token) {
  const parts = String(token).split(":");
  const pid = Number.parseInt(parts[0], 10);
  // New tokens are `pid:start:nonce` (3 segments). An older `pid:nonce` token
  // carries no fingerprint — treat its middle segment as absent so we fall back
  // to bare liveness rather than misreading a nonce as a start-time mismatch.
  const recordedStart = parts.length >= 3 ? parts[1] : null;
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, fingerprinted: false };
  let alive;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === "EPERM";
  }
  if (!alive) return { alive: false, fingerprinted: false };
  const current = pidStartTime(pid);
  if (recordedStart && recordedStart !== "0" && current) {
    // Fingerprint mismatch ⇒ the pid was recycled by another process; the
    // original holder is gone even though *some* process holds the pid.
    return { alive: current === recordedStart, fingerprinted: true };
  }
  return { alive: true, fingerprinted: false }; // can't fingerprint ⇒ bare liveness
}

/**
 * Run `fn` while holding an exclusive filesystem lock, so concurrent processes
 * touching the same lockPath serialize instead of racing on a read-modify-write.
 * Uses mkdir as the mutex primitive (atomic on POSIX). The holder writes an
 * owner token (pid + start-time fingerprint + nonce); a waiter reclaims only if
 * that holder is provably gone — its pid is dead, or a start-time mismatch
 * proves the pid was recycled — falling back to a long mtime age only when the
 * holder can't be fingerprinted. A holder releases only a lock whose token
 * still matches its own — so a live holder's lock is never stolen (even across
 * a >60s critical section) and a reclaimed lock is never double-released
 * (ABA-safe).
 * @param {string} lockPath
 * @param {() => any} fn
 * @returns {any}
 */
export function withFileLock(lockPath, fn) {
  ensureDir(path.dirname(lockPath));
  const token = `${process.pid}:${pidStartTime(process.pid) ?? "0"}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(lockOwnerFile(lockPath), token, "utf8");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Someone holds it. Reclaim ONLY if the holder is provably gone.
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished between the failed mkdir and this stat; retry
      }
      const owner = readLockOwner(lockPath);
      let reclaim;
      if (!owner) {
        reclaim = ageMs > LOCK_STALE_FALLBACK_MS; // unreadable token ⇒ age fallback
      } else {
        const { alive, fingerprinted } = ownerLiveState(owner);
        if (!alive) reclaim = true; // dead OR recycled pid ⇒ reclaim now
        else if (fingerprinted) reclaim = false; // provably the same live holder ⇒ never steal
        else reclaim = ageMs > LOCK_STALE_FALLBACK_MS; // live but unfingerprinted ⇒ age fallback
      }
      if (reclaim) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // lost the reclaim race to another waiter; retry
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    // Only remove the lock if it is STILL ours — a stale-reclaim by another
    // process may have replaced it, and we must never delete a lock we no
    // longer own (would break the new holder's mutual exclusion).
    if (readLockOwner(lockPath) === token) {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}
