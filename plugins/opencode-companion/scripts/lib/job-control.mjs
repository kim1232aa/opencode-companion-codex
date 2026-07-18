// Job control: query, sort, enrich, and build status snapshots.

import { tailLines, pidStartTime, writeJson, appendLine } from "./fs.mjs";
import { jobLogPath, jobDataPath, upsertJob, updateState, loadState } from "./state.mjs";
import { createClient, isServerRunning } from "./opencode-server.mjs";

const RECOVERY_PROBE_TIMEOUT_MS = 8_000;
// How long a worker-dead job may wait for the server to finish generating before
// we stop keeping it alive and let it fail (guards against a wedged server).
const AWAIT_SERVER_MAX_MS = 45 * 60_000;
const DEFAULT_HOST_FALLBACK = "127.0.0.1";

// pidStartTime lives in fs.mjs (the lowest-level module, so the file lock can
// use it too); re-export it here to keep existing importers working.
export { pidStartTime };

/**
 * True if the given pid is currently alive. Missing/invalid pid ⇒ dead.
 * @param {number|undefined|null} pid
 */
function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not signalable by us
  }
}

/**
 * Whether `pid` is alive AND (when both fingerprints are known) still the same
 * process we spawned. If start-times are known and differ, the pid was recycled
 * by an unrelated process — treat as NOT ours so we never signal it. When a
 * fingerprint is unavailable (non-Linux, or none was captured), falls back to a
 * bare liveness check.
 * @param {number} pid
 * @param {string|null|undefined} expectedStart
 * @returns {boolean}
 */
export function isOwnedProcessAlive(pid, expectedStart) {
  if (!isPidAlive(pid)) return false;
  const current = pidStartTime(pid);
  if (expectedStart && current) return current === expectedStart;
  return true; // can't fingerprint ⇒ best-effort liveness only
}

/**
 * Reconcile jobs whose worker process is gone but whose status is still
 * non-terminal — they were stranded (SIGKILL/OOM/reboot before runTrackedJob
 * could mark them). Marks them failed so status/result/cancel stop showing a
 * phantom "running" job forever. Returns the refreshed job list.
 * @param {string} workspacePath
 * @param {object[]} jobs
 * @returns {object[]}
 */
const PENDING_STALE_MS = 60_000;

export function reconcileStrandedJobs(workspacePath, jobs) {
  let changed = false;
  const now = Date.now();
  for (const j of jobs ?? []) {
    const terminal = j.status === "completed" || j.status === "failed" || j.status === "canceled";
    if (terminal) continue;

    // recoverStrandedResults flagged this job as still generating server-side
    // (worker dead, session busy). Don't fail it — a later poll will recover the
    // result — unless it has waited past the bound (a wedged server). The bound
    // measures time since waiting BEGAN (awaitingServerSince), not job age.
    if (j.awaitingServer) {
      const started = new Date(j.awaitingServerSince || j.createdAt || 0).getTime();
      if (Number.isFinite(started) && now - started < AWAIT_SERVER_MAX_MS) continue;
    }

    let reason = null;
    if (j.pid) {
      // Known worker pid that is no longer alive (or was recycled by an
      // unrelated process) ⇒ our worker died mid-run.
      if (!isOwnedProcessAlive(j.pid, j.pidStart)) {
        reason = `Worker process (pid ${j.pid}) exited without completing.`;
      }
    } else {
      // No worker pid was ever recorded. If it has been non-terminal for a
      // while, the worker never started (spawn failed / parent died) — it
      // would otherwise show as a phantom "pending" job forever.
      const t = new Date(j.updatedAt || j.createdAt || 0).getTime();
      const age = now - t;
      if (Number.isFinite(age) && age > PENDING_STALE_MS) {
        reason = `No worker process ever started (stranded ${Math.round(age / 1000)}s).`;
      }
    }

    if (reason) {
      upsertJob(workspacePath, {
        id: j.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: reason,
      });
      changed = true;
    }
  }
  return changed ? (loadState(workspacePath).jobs ?? jobs) : jobs;
}

/**
 * Salvage results for stranded jobs directly from the OpenCode server BEFORE
 * they get reconciled to "failed". When a worker is hard-killed (SIGKILL/OOM)
 * after sending its prompt, it can't write a result — but the OpenCode session
 * often finished server-side. For each non-terminal job whose worker is gone
 * and that has an opencodeSessionId, fetch the session's final answer; if there
 * is one, mark the job completed and persist the recovered result. Best-effort:
 * any probe failure (server down, no output) leaves the job for reconcile to
 * mark failed. Returns the refreshed job list.
 * @param {string} workspacePath
 * @param {object[]} jobs
 * @param {string} serverUrl
 * @returns {Promise<object[]>}
 */
export async function recoverStrandedResults(workspacePath, jobs, serverUrl, deps = {}) {
  const candidates = (jobs ?? []).filter((j) => {
    const terminal = j.status === "completed" || j.status === "failed" || j.status === "canceled";
    if (terminal || !j.opencodeSessionId) return false;
    // Only probe when the worker is provably gone; a live worker finishes itself.
    return j.pid ? !isOwnedProcessAlive(j.pid, j.pidStart) : true;
  });
  if (!candidates.length) return jobs;

  // One quick health check up front — if the server is gone there is nothing to
  // recover, and we avoid per-candidate connection stalls.
  let host = DEFAULT_HOST_FALLBACK;
  let port;
  try {
    const u = new URL(serverUrl);
    host = u.hostname;
    port = Number(u.port) || undefined;
  } catch {
    /* use isServerRunning defaults */
  }
  const healthy = deps.healthy ?? (await isServerRunning(host, port));
  if (!healthy) {
    // Server unreachable at THIS tick ≠ the answer is lost. Returning the jobs
    // untouched let reconcile take the dead-pid branch and mark them failed —
    // terminally, so a finished answer became unrecoverable after a transient
    // blip. Keep the candidates alive (awaitingServer) instead; the
    // AWAIT_SERVER_MAX_MS bound in reconcileStrandedJobs still fails them
    // honestly if the server never comes back.
    for (const j of candidates) {
      upsertJob(workspacePath, {
        id: j.id,
        awaitingServer: true,
        awaitingServerSince: j.awaitingServerSince ?? new Date().toISOString(),
      });
    }
    return loadState(workspacePath).jobs ?? jobs;
  }

  const client = deps.client ?? createClient(serverUrl);
  for (const j of candidates) {
    const since = Date.parse(j.createdAt || "") || 0;
    // Upper bound for a SHARED session (--resume-last): if a LATER job reuses
    // this job's opencodeSessionId, this job's window ends where that one's
    // begins — otherwise the probe's "latest completed turn" would persist the
    // later job's answer as this job's result.
    const laterStarts = (jobs ?? [])
      .filter((o) => o !== j && o.opencodeSessionId === j.opencodeSessionId)
      .map((o) => Date.parse(o.createdAt || "") || 0)
      .filter((t) => t > since);
    const until = laterStarts.length ? Math.min(...laterStarts) : 0;
    let probe = { text: null, active: false };
    try {
      probe = await client.getSessionResult(j.opencodeSessionId, {
        since,
        until,
        timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      // Probe FAILURE ≠ "server has no answer". The health check above said the
      // server is up, so a throw here means busy/slow/transient — treating it as
      // "no answer" let reconcile mark a still-generating job `failed` while its
      // session kept running (and a later probe then flipped it back to
      // completed: contradictory outcomes). Keep the job alive like an active
      // turn and let the next poll retry; the awaitingServer bound in
      // reconcileStrandedJobs still prevents a forever-zombie.
      try {
        appendLine(jobLogPath(workspacePath, j.id), `[${new Date().toISOString()}] recovery probe failed: ${err.message}`);
      } catch { /* logging is best-effort */ }
      upsertJob(workspacePath, {
        id: j.id,
        awaitingServer: true,
        awaitingServerSince: j.awaitingServerSince ?? new Date().toISOString(),
      });
      continue;
    }
    if (probe.text) {
      const usage = await client
        .getSessionUsage(j.opencodeSessionId, { since, timeoutMs: RECOVERY_PROBE_TIMEOUT_MS })
        .catch(() => null);
      // CAS the finalize INSIDE the state lock — the candidate set was
      // snapshotted BEFORE the (up to 8s) probe await, so a user cancel can land
      // mid-probe. Every other finalize guards on running/pending; without the
      // same guard here the cancel was silently overwritten back to "completed"
      // AND a result data file was persisted for a canceled job — double
      // contract violation. Claim first; only a successful claim writes data.
      let finalized = false;
      updateState(workspacePath, (state) => {
        const job = state.jobs?.find((x) => x.id === j.id);
        if (!job) return;
        if (job.status !== "running" && job.status !== "pending") return; // e.g. canceled mid-probe
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        job.result = probe.text.slice(0, 500);
        job.recovered = true;
        job.awaitingServer = false;
        job.updatedAt = new Date().toISOString();
        finalized = true;
      });
      if (finalized) {
        writeJson(jobDataPath(workspacePath, j.id), {
          rendered: probe.text,
          usage,
          recovered: true,
          summary: probe.text.slice(0, 500),
        });
      }
    } else if (probe.active) {
      // Worker is gone but the server is still generating our answer — keep the
      // job alive so a later poll can recover it instead of failing it now.
      // Record WHEN waiting began so the reconcile bound measures actual
      // server-wait time, not total job age.
      upsertJob(workspacePath, {
        id: j.id,
        awaitingServer: true,
        awaitingServerSince: j.awaitingServerSince ?? new Date().toISOString(),
      });
    }
    // else (empty): leave it for reconcileStrandedJobs to mark failed.
  }
  // Always reload so the caller and the subsequent reconcile see fresh state
  // (a concurrent worker may also have finalized a job while we probed).
  return loadState(workspacePath).jobs ?? jobs;
}

/**
 * Sort jobs newest first by updatedAt.
 * @param {object[]} jobs
 * @returns {object[]}
 */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Enrich a job with computed fields: elapsed time, progress preview, phase.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {object}
 */
export function enrichJob(job, workspacePath) {
  const enriched = { ...job };

  // Elapsed time
  if (job.createdAt) {
    const start = new Date(job.createdAt).getTime();
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    enriched.elapsedMs = end - start;
    enriched.elapsed = formatDuration(enriched.elapsedMs);
  }

  // Progress preview from log tail. Take a slightly deeper tail (not just 3
  // lines) so a single beat's heartbeat AND its internal activity lines
  // (bash/edit/read …) both land in the preview for status to surface.
  if (job.status === "running") {
    const logFile = jobLogPath(workspacePath, job.id);
    const lines = tailLines(logFile, 10);
    if (lines.length > 0) {
      enriched.progressPreview = lines.join("\n");
    }
  }

  // Infer phase from log
  if (job.status === "running" && !job.phase) {
    enriched.phase = inferPhase(job, workspacePath);
  }

  return enriched;
}

/**
 * Infer the current phase of a running job from its log.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {string}
 */
function inferPhase(job, workspacePath) {
  const logFile = jobLogPath(workspacePath, job.id);
  const lines = tailLines(logFile, 20);
  // report() writes lines shaped "[<iso-time>] [<phase>] <message>". Read the
  // phase from the most recent such line rather than fuzzy-matching free text —
  // keyword matching misclassifies benign model progress notes (e.g. a line
  // mentioning "writing tests" or "no errors" would flip the phase wrongly).
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[[^\]]+\]\s+\[([^\]]+)\]/);
    if (m) return m[1];
  }
  return "running";
}

/**
 * Build a status snapshot for display.
 * @param {object[]} jobs
 * @param {string} workspacePath
 * @param {{ sessionId?: string }} opts
 * @returns {{ running: object[], latestFinished: object|null, recent: object[] }}
 */
export function buildStatusSnapshot(jobs, workspacePath, opts = {}) {
  let filtered = jobs;
  if (opts.sessionId) {
    filtered = jobs.filter((j) => j.sessionId === opts.sessionId);
  }

  const sorted = sortJobsNewestFirst(filtered);
  const enriched = sorted.map((j) => enrichJob(j, workspacePath));

  const running = enriched.filter((j) => j.status === "running" || j.status === "pending");
  const finished = enriched.filter(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "canceled"
  );
  const latestFinished = finished[0] ?? null;
  const recent = finished.slice(0, 5);

  return { running, latestFinished, recent };
}

/**
 * Find a single job by ID or prefix match.
 * @param {object[]} jobs
 * @param {string} ref
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function matchJobReference(jobs, ref) {
  if (!ref) return { job: null, ambiguous: false };

  // Exact match first
  const exact = jobs.find((j) => j.id === ref);
  if (exact) return { job: exact, ambiguous: false };

  // Prefix match
  const matches = jobs.filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return { job: matches[0], ambiguous: false };
  if (matches.length > 1) return { job: null, ambiguous: true };

  return { job: null, ambiguous: false };
}

/**
 * Resolve a job that has finished (completed or failed).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveResultJob(jobs, ref, opts = {}) {
  let pool = jobs.filter(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "canceled"
  );
  // Without an explicit ref, scope STRICTLY to this Claude session (like status
  // does). No fallback to the global pool: silently returning another session's
  // newest job would present a stranger's result as ours. An explicit job id
  // still reaches any session's job.
  if (!ref && opts.sessionId) {
    pool = pool.filter((j) => j.sessionId === opts.sessionId);
  }
  if (!ref) {
    const sorted = sortJobsNewestFirst(pool);
    return { job: sorted[0] ?? null, ambiguous: false };
  }
  return matchJobReference(pool, ref);
}

/**
 * Resolve every job that can be canceled — supports "cancel-all". With a `ref`,
 * behaves like a single-job lookup (one job, or ambiguous). Without a ref,
 * returns ALL running/pending jobs for this Claude session (scoped by
 * opts.sessionId so another session's jobs are never touched); an unset
 * sessionId falls back to all running jobs, matching the single-job resolver.
 * @param {object[]} jobs
 * @param {string} [ref]
 * @param {{ sessionId?: string }} [opts]
 * @returns {{ jobs: object[], ambiguous: boolean }}
 */
export function resolveCancelableJobs(jobs, ref, opts = {}) {
  const running = jobs.filter((j) => j.status === "running" || j.status === "pending");
  if (ref) {
    const { job, ambiguous } = matchJobReference(running, ref);
    return { jobs: job ? [job] : [], ambiguous };
  }
  const scoped = opts.sessionId
    ? running.filter((j) => j.sessionId === opts.sessionId)
    : running;
  return { jobs: scoped, ambiguous: false };
}

/**
 * Format a duration in milliseconds to human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
