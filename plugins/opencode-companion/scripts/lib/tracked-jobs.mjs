// Job lifecycle tracking and progress reporting for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendLine, pidStartTime, readJson, writeJson } from "./fs.mjs";
import { generateJobId, upsertJob, updateState, loadState, jobLogPath, jobDataPath } from "./state.mjs";
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
 * Whether a job has been marked canceled in shared state. Used as the
 * dispatchWithRetry `shouldStop` signal so an external cancel — a separate
 * `cancel`/`oc_cancel` process, or an MCP `notifications/cancelled` — aborts the
 * run instead of being mistaken for a transient fault and retried on a fresh
 * session (which would re-run a write task).
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {boolean}
 */
export function isJobCanceled(workspacePath, jobId) {
  try {
    return (loadState(workspacePath).jobs ?? []).find((j) => j.id === jobId)?.status === "canceled";
  } catch {
    return false;
  }
}

const TASK_PREVIEW_MAX = 100;

/**
 * Condense free-form task text into a short, single-line preview for the job
 * record. The full text is never stored in state (it can be long and may carry
 * sensitive content); the preview exists so a job can be diagnosed after the
 * fact — "which task was this, and what model did it actually request?".
 * @param {string} [text]
 * @param {number} [max]
 * @returns {string|undefined} undefined when there is nothing to preview
 */
export function taskPreview(text, max = TASK_PREVIEW_MAX) {
  if (typeof text !== "string") return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Normalize job metadata: persist the REQUESTED model (state used to carry no
 * model field at all, so "which model did that job actually ask for?" was
 * unanswerable after the run) and a short task preview, while keeping the raw
 * task text out of state.
 * @param {object} meta
 * @returns {object}
 */
function normalizeJobMeta(meta = {}) {
  const { taskText, ...rest } = meta;
  const requested = rest.requestedModel ?? rest.model;
  if (typeof requested === "string" && requested.trim()) {
    rest.requestedModel = requested.trim();
  } else {
    delete rest.requestedModel;
  }
  const preview = taskPreview(taskText);
  if (preview) rest.taskPreview = preview;
  // Drop undefined-valued keys: as an upsert patch they would otherwise ERASE a
  // field the record already carries (e.g. a worker patch with no --model
  // wiping the model the parent recorded).
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) delete rest[k];
  }
  return rest;
}

/**
 * Path of a job's REQUEST file — the dispatch payload (task text + routing) a
 * detached worker reads back by job id. Lives next to the job's log/result under
 * the 0700 state dir and is written 0600 (writeJson), so the task text never
 * travels on a command line where `ps` / /proc/<pid>/cmdline exposes it.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobRequestPath(workspacePath, jobId) {
  const dataFile = jobDataPath(workspacePath, jobId); // <state>/jobs/<id>.json
  return path.join(path.dirname(dataFile), `${jobId}.request.json`);
}

/**
 * Persist a job's dispatch request (task text, model, agent, routing flags).
 * @param {string} workspacePath
 * @param {string} jobId
 * @param {object} request
 * @returns {string} the request file path
 */
export function writeJobRequest(workspacePath, jobId, request = {}) {
  const file = jobRequestPath(workspacePath, jobId);
  writeJson(file, { jobId, createdAt: new Date().toISOString(), ...request });
  return file;
}

/**
 * Read back a job's dispatch request.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {object|null} null when absent/unreadable
 */
export function readJobRequest(workspacePath, jobId) {
  if (!workspacePath || !jobId) return null;
  return readJson(jobRequestPath(workspacePath, jobId));
}

/**
 * Create a new job record. When `meta.taskText` is present the task text is
 * ALSO persisted to the job's request file, so a detached worker can be spawned
 * with nothing but `--job-id` and read the task back itself. That is what makes
 * a task text starting with `--` safe: it never passes through argv, where the
 * worker's parser used to reject it as an option and start with an EMPTY task.
 * @param {string} workspacePath
 * @param {string} type - "review" | "adversarial-review" | "task"
 * @param {object} [meta] - additional metadata; `model`/`requestedModel` and
 *   `taskText` are normalized into `requestedModel` / `taskPreview`
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
    ...normalizeJobMeta(meta),
  };
  upsertJob(workspacePath, job);
  if (typeof meta.taskText === "string" && meta.taskText.trim()) {
    writeJobRequest(workspacePath, id, {
      taskText: meta.taskText,
      model: meta.model ?? meta.requestedModel,
      agent: meta.agent,
      write: meta.write,
      worktree: meta.worktree,
      resumeSessionId: meta.resumeSessionId,
    });
  }
  return job;
}

/**
 * Record what an already-created job was actually asked to do. Used by the
 * detached worker, which is the ground truth for the task text and model it
 * actually received (it can also be launched directly, without the parent that
 * created the record).
 * @param {string} workspacePath
 * @param {string} jobId
 * @param {{ model?: string, taskText?: string }} [request]
 */
export function recordJobRequest(workspacePath, jobId, request = {}) {
  if (!workspacePath || !jobId) return;
  const patch = normalizeJobMeta({ model: request.model, taskText: request.taskText });
  if (!Object.keys(patch).length) return;
  upsertJob(workspacePath, { id: jobId, ...patch });
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
