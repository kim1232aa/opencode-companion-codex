// Job lifecycle tracking and progress reporting for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendLine, pidStartTime } from "./fs.mjs";
import { generateJobId, upsertJob, updateState, jobLogPath, jobDataPath } from "./state.mjs";
import { isEmptyResult } from "./render.mjs";

const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

/**
 * Get the current Claude session ID from environment.
 * @returns {string|undefined}
 */
export function getClaudeSessionId() {
  // Claude Code exposes the live session id as CLAUDE_CODE_SESSION_ID (NOT the
  // non-existent CLAUDE_SESSION_ID); the OPENCODE_COMPANION_SESSION_ID override
  // still wins when present.
  return process.env[SESSION_ID_ENV] || process.env.CLAUDE_CODE_SESSION_ID;
}

/**
 * Create a new job record.
 * @param {string} workspacePath
 * @param {string} type - "review" | "adversarial-review" | "task"
 * @param {object} [meta] - additional metadata
 * @returns {object} the created job
 */
export function createJobRecord(workspacePath, type, meta = {}) {
  const id = generateJobId(type);
  const sessionId = getClaudeSessionId();
  const job = {
    id,
    type,
    status: "pending",
    sessionId,
    ...meta,
  };
  upsertJob(workspacePath, job);
  return job;
}

/**
 * Run a tracked job with full lifecycle management.
 * @param {string} workspacePath
 * @param {object} job
 * @param {(ctx: { report: Function, log: Function }) => Promise<object>} runner
 * @returns {Promise<object>} the job result
 */
export async function runTrackedJob(workspacePath, job, runner) {
  // Mark as running. Record pidStart alongside pid so isOwnedProcessAlive can
  // fingerprint this worker even when it was launched directly (e.g. task-worker
  // invoked without the parent spawn path that would otherwise set pidStart).
  upsertJob(workspacePath, {
    id: job.id,
    status: "running",
    pid: process.pid,
    pidStart: pidStartTime(process.pid),
  });

  const logFile = jobLogPath(workspacePath, job.id);
  ensureDir(path.dirname(logFile));

  const report = (phase, message) => {
    const line = `[${new Date().toISOString()}] [${phase}] ${message}`;
    appendLine(logFile, line);
    process.stderr.write(line + "\n");
    upsertJob(workspacePath, { id: job.id, phase });
  };

  const log = (message) => {
    appendLine(logFile, `[${new Date().toISOString()}] ${message}`);
  };

  try {
    report("starting", `Job ${job.id} started`);
    const result = await runner({ report, log });

    // Mark as completed — CAS: an aborted OpenCode session RETURNS normally
    // with partial output instead of throwing, so a cancel that landed during
    // the run must not be overwritten by a bogus "completed".
    let finalized = false;
    updateState(workspacePath, (state) => {
      const j = state.jobs?.find((x) => x.id === job.id);
      if (!j) return;
      if (j.status !== "running" && j.status !== "pending") return; // e.g. canceled
      j.status = "completed";
      j.completedAt = new Date().toISOString();
      j.result = result?.rendered ?? result?.summary ?? null;
      j.emptyResult = isEmptyResult(result);
      j.updatedAt = new Date().toISOString();
      finalized = true;
    });

    // Write result data file
    const dataFile = jobDataPath(workspacePath, job.id);
    ensureDir(path.dirname(dataFile));
    fs.writeFileSync(dataFile, JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });

    if (finalized) report("completed", `Job ${job.id} completed`);
    return result;
  } catch (err) {
    // CAS: don't clobber a status someone else already finalized — e.g. cancel
    // wrote "canceled" and THEN aborted our session, which is what made this
    // very code path throw. Overwriting would flip a user's cancel to "failed".
    let wrote = false;
    updateState(workspacePath, (state) => {
      const j = state.jobs?.find((x) => x.id === job.id);
      if (!j) return;
      if (j.status !== "running" && j.status !== "pending") return; // already terminal
      j.status = "failed";
      j.completedAt = new Date().toISOString();
      j.errorMessage = err.message;
      j.updatedAt = new Date().toISOString();
      wrote = true;
    });
    if (wrote) report("failed", `Job ${job.id} failed: ${err.message}`);
    throw err;
  }
}

/**
 * Create a progress reporter for a job.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {{ report: Function, log: Function }}
 */
export function createProgressReporter(workspacePath, jobId) {
  const logFile = jobLogPath(workspacePath, jobId);

  return {
    report(phase, message) {
      const line = `[${new Date().toISOString()}] [${phase}] ${message}`;
      appendLine(logFile, line);
      upsertJob(workspacePath, { id: jobId, phase });
    },
    log(message) {
      appendLine(logFile, `[${new Date().toISOString()}] ${message}`);
    },
  };
}
