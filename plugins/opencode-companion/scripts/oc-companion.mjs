#!/usr/bin/env node

// OpenCode Companion for Codex — an MCP (stdio) server that lets Codex
// delegate coding tasks to OpenCode, pointed at any OpenAI-compatible backend.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport).
// Delegation runs IN-PROCESS: a tools/call for oc_delegate stays pending until
// the OpenCode session finishes (the plugin's .mcp.json sets a 7-day
// tool_timeout_sec ceiling), so there is no polling, no detached worker for
// the happy path, and cancellation maps to MCP's notifications/cancelled.
// Task text arrives as structured JSON-RPC params — it never touches argv, so
// it cannot leak through the process list.

import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isOpencodeInstalled, getOpencodeVersion, terminateGroup } from "./lib/process.mjs";
import { isServerRunning, ensureServer, connect, createClient, suggestModelRefs, dispatchWithRetry } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, jobDataPath } from "./lib/state.mjs";
import {
  buildStatusSnapshot,
  resolveResultJob,
  resolveCancelableJobs,
  enrichJob,
  reconcileStrandedJobs,
  recoverStrandedResults,
  isOwnedProcessAlive,
} from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId, isJobCanceled, taskPreview } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup, formatUsage, formatTrailer } from "./lib/render.mjs";
import { buildTaskPrompt, buildReviewPrompt } from "./lib/prompts.mjs";
import { assertSafeRef } from "./lib/git.mjs";
import { withWorktree } from "./lib/worktree.mjs";
import { readJson } from "./lib/fs.mjs";

const SERVER_VERSION = "0.6.0";
const PROTOCOL_VERSION = "2025-03-26";

// Plugin root — the directory that holds prompts/ and schemas/. Reviews read
// their prompt templates from here. The stdio server lives at
// <root>/scripts/oc-companion.mjs, so the root is the parent of this file's dir.
// An explicit env override wins so a relocated launch can still find templates.
// fileURLToPath(import.meta.url), not import.meta.dirname (Node 20.11+): engines
// declares >=18.18, and on 18/19 import.meta.dirname is undefined → path.resolve
// throws at startup when neither env override is set.
const PLUGIN_ROOT =
  process.env.OPENCODE_COMPANION_PLUGIN_ROOT ||
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultServerUrl() {
  const port = Number(process.env.OPENCODE_SERVER_PORT) || 4096;
  return `http://127.0.0.1:${port}`;
}

// ─── JSON-RPC plumbing ──────────────────────────────────────────────────────

function sendMessage(msg) {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    process.exit(0); // EPIPE — host is gone
  }
}
const sendResponse = (id, result) => sendMessage({ jsonrpc: "2.0", id, result });
const sendError = (id, code, message) => sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
const logErr = (m) => {
  try { process.stderr.write(`${m}\n`); } catch { /* broken stderr */ }
};

const text = (s) => ({ content: [{ type: "text", text: s }] });
const errText = (s) => ({ content: [{ type: "text", text: s }], isError: true });

// Compose the one-line result trailer appended to a delegate/review body. The
// user complained the old multi-line tail was "十分冗长", so the default is now
// formatTrailer's single concise line, with the Codex job id and OpenCode
// session id folded in — Codex needs the job id to call oc_status/oc_result/
// oc_cancel and the session id to resume via resumeSession. When usage is empty
// the token/model part drops out, but a bare "✓ job:… · session:…" still carries
// those ids. A model mismatch keeps formatTrailer's leading ⚠️ and its
// ran-vs-requested spelling. Setting OPENCODE_COMPANION_VERBOSE_TRAILER=1 (the
// same switch as the Claude Code frontend) restores the original multi-line
// formatUsage block; the full breakdown also always remains available from
// oc_result → renderResult, so no detail is lost by the concise default.
export function buildResultTrailer(usage, { requestedModel, sessionId, jobId } = {}) {
  const idBits = [];
  if (jobId) idBits.push(`job:${jobId}`);
  if (sessionId) idBits.push(`session:${sessionId}`);
  if (/^(1|true|yes|on)$/i.test(process.env.OPENCODE_COMPANION_VERBOSE_TRAILER || "")) {
    const parts = [];
    const full = formatUsage(usage, { requestedModel });
    if (full) parts.push(`---\n${full}`);
    if (idBits.length) parts.push(`[${idBits.join(" · ")}]`);
    return parts.length ? `\n${parts.join("\n")}` : "";
  }
  const base = formatTrailer(usage, { requestedModel });
  if (base) return `\n${idBits.length ? `${base} · ${idBits.join(" · ")}` : base}`;
  return idBits.length ? `\n✓ ${idBits.join(" · ")}` : "";
}

// requestId → ARRAY of { sessionId, jobId, workspace } for notifications/cancelled.
// It's an array (not a single entry) so a batch, whose sub-delegations all share
// the batch tools/call's requestId, can have EVERY sub-session aborted on cancel
// — not just one. A retry of the same job replaces that job's entry (fresh
// session); each job removes its own entry when it finishes.
const inflight = new Map();
function inflightAdd(requestId, entry) {
  if (requestId === undefined) return;
  const list = (inflight.get(requestId) ?? []).filter((e) => e.jobId !== entry.jobId);
  list.push(entry);
  inflight.set(requestId, list);
}
function inflightRemove(requestId, jobId) {
  if (requestId === undefined) return;
  const list = inflight.get(requestId);
  if (!list) return;
  const next = list.filter((e) => e.jobId !== jobId);
  if (next.length) inflight.set(requestId, next);
  else inflight.delete(requestId);
}

// Requests that have already received a notifications/cancelled. A batch's
// sub-delegations all share the batch requestId; one whose OpenCode session is
// created AFTER the cancel arrived would miss the handler's one-shot inflight
// snapshot and run to completion. registerSession/shouldStop consult this so a
// late session self-cancels instead. The cancel handler records the id in its
// SYNCHRONOUS prologue (before it snapshots and before its first await), so —
// single-threaded — a sub is guaranteed to be either in that snapshot or to see
// this flag when its own onSession runs. No gap.
const canceledRequests = new Set();
export function isRequestCanceled(requestId) {
  return requestId !== undefined && canceledRequests.has(requestId);
}
export function noteRequestCanceled(requestId) {
  if (requestId === undefined) return;
  canceledRequests.add(requestId);
  // Bound memory on a long-lived server: drop the oldest id past a soft cap.
  if (canceledRequests.size > 512) canceledRequests.delete(canceledRequests.values().next().value);
}

// Compare-and-set a job to canceled, never clobbering an already-terminal status.
function markJobCanceled(workspace, jobId) {
  updateState(workspace, (state) => {
    const j = state.jobs?.find((x) => x.id === jobId);
    if (j && (j.status === "running" || j.status === "pending")) {
      j.status = "canceled";
      j.completedAt = new Date().toISOString();
      j.errorMessage = "Canceled by user";
      j.updatedAt = new Date().toISOString();
    }
  });
}

// Abort an OpenCode session, time-bounded so a hung server can't wedge the caller
// for request()'s full 300s budget.
async function abortSessionBounded(workspace, sessionId) {
  try {
    const client = createClient(defaultServerUrl(), { directory: workspace });
    await withTimeout(Promise.resolve().then(() => client.abortSession(sessionId)), ABORT_TIMEOUT_MS);
  } catch { /* best-effort: timed out or server down */ }
}

// Register a freshly-created OpenCode session for cancellation. If a cancel for
// this request already arrived while the session was being created, abort it
// right away instead of letting it run to completion (see canceledRequests).
export function registerSession(requestId, workspace, jobId, sid) {
  upsertJob(workspace, { id: jobId, opencodeSessionId: sid });
  inflightAdd(requestId, { sessionId: sid, jobId, workspace });
  if (isRequestCanceled(requestId)) {
    markJobCanceled(workspace, jobId);
    abortSessionBounded(workspace, sid); // best-effort; shouldStop also bails the retry loop
  }
}

// ─── Output budget ──────────────────────────────────────────────────────────

// Shared wording for the brief/maxWords tool params. A delegated answer is
// returned INTO this caller's context and re-read on every later turn, while the
// delegated work itself costs the caller nothing — so the answer is the only
// part of a delegation that keeps billing, and it is capped by default.
const BRIEF_PARAM_DESC =
  "Keep the returned answer short: conclusion plus locators (file:line, commands), no whole-file or whole-diff dumps, no filler. " +
  "Defaults to TRUE — the result lands in YOUR context and is re-read on every later turn, so its length is a recurring cost while the delegated work is free. " +
  "Set false only when you actually want the long form (a full report, a generated document). It never limits how much WORK is done, only how much is reported.";
const MAX_WORDS_PARAM_DESC =
  "Hard word cap on the returned answer (e.g. 200). Implies brief. Anything that does not fit is replaced by a pointer to where it can be read in full.";

/**
 * Validate and normalize the output-budget arguments of a tool call.
 * @param {object} [args]
 * @returns {{ brief?: boolean, maxWords?: number, error?: string }}
 *   `brief: undefined` means the caller said nothing — the default then lives in
 *   ONE place (prompts.mjs DEFAULT_BRIEF) instead of being re-decided here.
 */
export function readOutputBudget(args = {}) {
  if (args.brief !== undefined && typeof args.brief !== "boolean") {
    return { error: "Error: brief, if supplied, must be a boolean." };
  }
  if (args.maxWords !== undefined) {
    const n = Number(args.maxWords);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: "Error: maxWords, if supplied, must be a positive number." };
    }
    // An explicit brief:false drops the cap with the budget — a caller that asked
    // for the long form never gets a word limit smuggled back in.
    return { brief: args.brief, maxWords: args.brief === false ? undefined : Math.floor(n) };
  }
  return { brief: args.brief, maxWords: undefined };
}

// ─── Workspace ──────────────────────────────────────────────────────────────

export async function resolveWorkspaceArg(args) {
  // An explicit workspace is taken verbatim (resolved to absolute). Otherwise,
  // fall back to git-root detection so a call from a subdirectory keys state to
  // the repository root instead of splintering state per-subdir.
  if (typeof args.workspace === "string" && args.workspace.trim()) {
    return path.resolve(args.workspace.trim());
  }
  return resolveWorkspace();
}

// ─── Tool definitions ───────────────────────────────────────────────────────

// Per-tool set of declared argument keys, for unknown-key rejection at the
// tools/call boundary (see handleMessage). MCP hosts pass arguments through
// structurally, so a typo'd key would otherwise be silently ignored and the
// parameter it was meant to set would silently default — e.g. {bsae: "main"}
// reviewing the working tree instead of the branch.
export function allowedToolArgKeys(toolName) {
  const tool = TOOLS.find((t) => t.name === toolName);
  return new Set(Object.keys(tool?.inputSchema?.properties ?? {}));
}
export function unknownToolArgKeys(toolName, args) {
  const allowed = allowedToolArgKeys(toolName);
  return Object.keys(args ?? {}).filter((k) => !allowed.has(k));
}

const TOOLS = [
  {
    name: "oc_delegate",
    description:
      "Delegate a coding task to OpenCode (running on any OpenAI-compatible backend) and BLOCK until it finishes, returning the full result plus a token-usage line. This single call is the whole delegation: do not poll, sleep, or emit waiting commentary while it is pending. Long tasks (15-30+ min) are normal. NOTE the cost shape: the WORK runs on OpenCode and costs you nothing, but the RESULT is returned into your context and re-read on every later turn — so the answer is capped by default (brief), and you should leave it that way unless you truly need the long form.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The full task text, verbatim and self-contained. OpenCode sees ONLY this text plus the repository — restate any context it needs." },
        model: { type: "string", description: "Optional provider/model ref (split on the FIRST slash; model ids may contain slashes). Omit for the provider default." },
        agent: { type: "string", enum: ["build", "plan"], description: "OpenCode agent. 'build' (default) has full write access; 'plan' is the ONLY read-only mode." },
        worktree: { type: "boolean", description: "Run a write-capable task in an isolated throwaway git worktree and apply the changes back (protects concurrent edits in the live repo)." },
        brief: { type: "boolean", description: BRIEF_PARAM_DESC },
        maxWords: { type: "number", description: MAX_WORDS_PARAM_DESC },
        resumeSession: { type: "string", description: "Explicit OpenCode session id to continue instead of starting fresh." },
        workspace: { type: "string", description: "Absolute path of the repository/workspace to operate in. Defaults to the server's cwd." },
      },
      required: ["task"],
    },
  },
  {
    name: "oc_delegate_batch",
    description:
      "Delegate SEVERAL independent coding tasks to OpenCode IN PARALLEL with a single call, blocking until ALL finish, and return every result. Use this instead of multiple oc_delegate calls whenever you have 2+ independent tasks (e.g. fanning out to different models or reviewing different modules) — the host executes MCP tools sequentially, so batching is the only way to get true parallelism. Same no-polling rule as oc_delegate. Every result lands in YOUR context, so N tasks means N answers to carry for the rest of the run: the per-task answer is capped by default (brief), and a partial failure still returns the tasks that did succeed.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          description: "Independent tasks to run concurrently. Each runs in its own OpenCode session.",
          items: {
            type: "object",
            properties: {
              task: { type: "string", description: "Full, self-contained task text (forwarded verbatim)." },
              model: { type: "string", description: "Optional provider/model ref for THIS task." },
              agent: { type: "string", enum: ["build", "plan"], description: "'build' (default, write) or 'plan' (read-only)." },
              worktree: { type: "boolean", description: "Isolate this write task in a throwaway git worktree. Strongly recommended when several write tasks in the batch touch the same repository." },
              brief: { type: "boolean", description: BRIEF_PARAM_DESC },
              maxWords: { type: "number", description: MAX_WORDS_PARAM_DESC },
              label: { type: "string", description: "Optional short label echoed back with this task's result." },
            },
            required: ["task"],
          },
        },
        workspace: { type: "string", description: "Workspace path for all tasks. Defaults to the server's cwd." },
      },
      required: ["tasks"],
    },
  },
  {
    name: "oc_status",
    description:
      "Show running and recent OpenCode jobs for a workspace. Running jobs display a live 'heartbeat: N tokens so far' line — tokens climbing across two calls means the model is generating; frozen means it is stuck. Also salvages results of jobs whose worker died.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Workspace path. Defaults to the server's cwd." },
      },
    },
  },
  {
    name: "oc_result",
    description:
      "Fetch the final output of a finished OpenCode job (newest finished job by default, or a specific job by id/prefix). If a job's worker died after dispatch, this recovers the finished answer from the OpenCode server (marked 'recovered') — run it before concluding a result was lost.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Job id or unique prefix. Omit for the newest finished job." },
        workspace: { type: "string", description: "Workspace path. Defaults to the server's cwd." },
      },
    },
  },
  {
    name: "oc_cancel",
    description: "Cancel a running OpenCode job: aborts its OpenCode session and marks the job canceled (never clobbers an already-finished result). Omit 'job' to cancel every running/pending job in this workspace.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Job id or unique prefix. Omit to cancel every running/pending job in this workspace." },
        workspace: { type: "string", description: "Workspace path. Defaults to the server's cwd." },
      },
    },
  },
  {
    name: "oc_setup",
    description: "Check whether OpenCode is installed, its server is reachable, and which providers are configured.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oc_review",
    description:
      "Run a READ-ONLY code review of a workspace's changes on OpenCode (a cheap OpenAI-compatible backend) and BLOCK until it returns structured findings. Reviews the working-tree diff by default, or a branch diff when 'base' is given. Same no-polling rule as oc_delegate: this single call is the whole review.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Optional base branch/ref to diff against (e.g. 'main'). Omit to review uncommitted working-tree changes." },
        model: { type: "string", description: "Optional provider/model ref (split on the FIRST slash). Omit for the provider default." },
        brief: { type: "boolean", description: "Tighten the PROSE inside the review's findings (summary/body/recommendation): conclusion plus locators, no padding. The JSON schema and every required field are unaffected. Unlike oc_delegate this is OPT-IN — review output is already bounded by the schema." },
        maxWords: { type: "number", description: "Optional word cap for the review's prose fields. Implies brief. Never drops a required field — it only shortens the writing inside them." },
        workspace: { type: "string", description: "Absolute path of the repository to review. Defaults to the server's cwd." },
      },
    },
  },
  {
    name: "oc_adversarial_review",
    description:
      "Run a READ-ONLY ADVERSARIAL code review on OpenCode — the reviewer actively tries to break confidence in the change (auth, data loss, race conditions, rollback/idempotency, version skew) and returns a terse ship/no-ship verdict with structured findings. BLOCKS until done. Use before merging risky changes; pass 'focus' to weight a specific concern.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Optional base branch/ref to diff against. Omit to review uncommitted working-tree changes." },
        focus: { type: "string", description: "Optional focus area to weight heavily (e.g. 'concurrency', 'the migration path')." },
        model: { type: "string", description: "Optional provider/model ref (split on the FIRST slash). Omit for the provider default." },
        brief: { type: "boolean", description: "Tighten the PROSE inside the findings (summary/body/recommendation). The JSON schema and every required field are unaffected. OPT-IN: review output is already schema-bounded." },
        maxWords: { type: "number", description: "Optional word cap for the review's prose fields. Implies brief. Never drops a required field." },
        workspace: { type: "string", description: "Absolute path of the repository to review. Defaults to the server's cwd." },
      },
    },
  },
  {
    name: "oc_resume_candidate",
    description:
      "Return the most recent resumable OpenCode task session for a workspace so a follow-up can continue it: { available, jobId, opencodeSessionId }. If available, pass opencodeSessionId as oc_delegate's resumeSession. Read-only lookup — does not start or contact a server.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Workspace path. Defaults to the server's cwd." },
      },
    },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleDelegate(args, requestId) {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return errText("Error: task is required and must be a non-empty string.");
  if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim())) {
    return errText("Error: model, if supplied, must be a non-empty provider/model string.");
  }
  const budget = readOutputBudget(args);
  if (budget.error) return errText(budget.error);
  const agentName = args.agent === "plan" ? "plan" : "build";
  const isWrite = agentName !== "plan";
  const useWorktree = !!args.worktree && isWrite;
  const workspace = await resolveWorkspaceArg(args);
  const resumeSessionId = typeof args.resumeSession === "string" && args.resumeSession.trim()
    ? args.resumeSession.trim()
    : null;

  // Record the routing metadata so status/watch/result show WHICH model and WHAT
  // task (CC's task path stores the same). Use taskPreview directly rather than
  // taskText: passing taskText would make createJobRecord write a `.request.json`
  // dispatch file, but Codex delegations run in-process — nothing ever reads that
  // file back (no detached worker), so it would only be dead clutter.
  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
    model: args.model,
    write: isWrite,
    worktree: useWorktree,
    taskPreview: taskPreview(task),
  });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) =>
      withWorktree({ dir: workspace, jobId: job.id, useWorktree, isWrite }, async (effectiveCwd) => {
        report("starting", "Connecting to OpenCode server...");
        const client = await connect({ cwd: effectiveCwd });

        // Resolve the model ref up front. OpenCode's UI can show a provider
        // display NAME that differs from the ID a ref needs, and model ids
        // themselves can contain slashes — so callers routinely drop
        // the provider prefix. If the dropped-prefix ref is UNAMBIGUOUS we fix
        // it automatically (the token line then shows what actually ran); if it
        // is ambiguous or unknown we fail fast with concrete suggestions instead
        // of a cryptic mid-run 500.
        if (args.model) {
          const refs = await client.listModelRefs().catch(() => null);
          if (refs && refs.size && !refs.has(args.model)) {
            const exact = suggestModelRefs(refs, args.model, 50).filter((r) => r.endsWith(`/${args.model}`));
            if (exact.length === 1) {
              log(`Model "${args.model}" resolved to "${exact[0]}" (added the provider prefix).`);
              args.model = exact[0];
              // Keep the job record consistent with the trailer: it was created
              // BEFORE resolution, so status/watch showed the raw ref while the
              // result showed the resolved one.
              upsertJob(workspace, { id: job.id, requestedModel: args.model });
            } else {
              const sugg = suggestModelRefs(refs, args.model);
              throw new Error(
                `Model "${args.model}" is not available on the OpenCode server.` +
                (sugg.length ? ` Did you mean: ${sugg.join("  |  ")} ?` : "") +
                ` A ref is <providerID>/<modelID>; the providerID is the id from your opencode config (not necessarily the display name OpenCode's UI shows), and the modelID may itself contain slashes. Run oc_setup to list the exact provider IDs.`
              );
            }
          }
        }

        const prompt = buildTaskPrompt(task, { write: isWrite, brief: budget.brief, maxWords: budget.maxWords });
        report("investigating", "Running task...");
        log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${prompt.length} chars, Model: ${args.model ?? "(provider default)"}, Brief: ${budget.brief === false ? "off" : "on"}${budget.maxWords ? `, MaxWords: ${budget.maxWords}` : ""}`);

        // Dispatch with retries: a transient 500, an empty turn, or a hang (no
        // token progress) is retried on a fresh session instead of failing.
        const dispatchedAt = Date.now(); // usage window: this run's turns only (a RESUMED session carries the previous task's turns)
        const dispatch = await dispatchWithRetry({
          client,
          prompt,
          agent: agentName,
          model: args.model,
          extract: extractResponseText,
          log,
          resumeSessionId,
          makeSession: () => client.createSession({ title: `Codex delegate ${job.id}` }),
          onSession: (sid) => registerSession(requestId, workspace, job.id, sid),
          shouldStop: () => isJobCanceled(workspace, job.id) || isRequestCanceled(requestId),
        });
        const response = dispatch.response;
        const sessionId = dispatch.sessionId;
        if (dispatch.attempts > 1) log(`Succeeded on attempt ${dispatch.attempts}.`);

        const bodyText = extractResponseText(response);
        const usage = await client.getSessionUsage(sessionId, { since: dispatchedAt }).catch(() => null);

        let changedFiles = [];
        if (isWrite) {
          try {
            const diff = await client.getSessionDiff(sessionId);
            if (diff?.files) changedFiles = diff.files.map((f) => f.path || f.name).filter(Boolean);
          } catch { /* diff endpoint may be unavailable */ }
        }

        report("finalizing", "Done");
        return { rendered: bodyText, usage, changedFiles, summary: bodyText.slice(0, 500), opencodeSessionId: sessionId, requestedModel: args.model };
      }, log)
    );

    // An empty (non-stalled) turn now throws inside dispatchWithRetry and is
    // handled by the catch below, so a successful return here always carries
    // real text — no empty-output guard needed on this path.
    const lines = [result.rendered];
    // One concise trailer line (job + session folded in so Codex can drive
    // oc_status/oc_result/oc_cancel and resume); VERBOSE_TRAILER=1 restores the
    // old multi-line breakdown. Changed files stay a separate block — useful.
    const trailer = buildResultTrailer(result.usage, {
      requestedModel: result.requestedModel,
      sessionId: result.opencodeSessionId,
      jobId: job.id,
    });
    if (trailer) lines.push(trailer);
    if (result.changedFiles?.length) {
      lines.push(`\nChanged files:\n${result.changedFiles.map((f) => `- ${f}`).join("\n")}`);
    }
    return text(lines.join("\n"));
  } catch (err) {
    return errText(`Delegation failed (job ${job.id}): ${err.message}. If OpenCode kept running server-side, oc_result may still recover the answer.`);
  } finally {
    inflightRemove(requestId, job.id);
  }
}

export async function handleDelegateBatch(args, requestId, deps = {}) {
  // Injectable seams keep the fan-out orchestration unit-testable without a
  // live server; production passes nothing and gets the real implementations.
  const ensureServerFn = deps.ensureServer ?? ensureServer;
  const runDelegate = deps.handleDelegate ?? handleDelegate;

  const tasks = Array.isArray(args.tasks) ? args.tasks : null;
  if (!tasks || tasks.length === 0) {
    return errText("Error: tasks must be a non-empty array of { task, model?, agent?, worktree?, label? }.");
  }
  for (const [i, t] of tasks.entries()) {
    if (!t || typeof t.task !== "string" || !t.task.trim()) {
      return errText(`Error: tasks[${i}].task is required and must be a non-empty string.`);
    }
    // Reject a malformed budget BEFORE dispatching anything: an unusable
    // brief/maxWords on task 3 must not be discovered after tasks 1-2 have
    // already burned a run.
    const budget = readOutputBudget(t);
    if (budget.error) return errText(budget.error.replace(/^Error: /, `Error: tasks[${i}].`));
  }
  const workspace = typeof args.workspace === "string" ? args.workspace : undefined;

  // Warm the OpenCode server exactly once BEFORE fanning out. Each handleDelegate
  // otherwise calls connect()→ensureServer() concurrently; on a cold start they
  // all race to spawn `opencode serve` on the same port and every loser dies with
  // an earlyExit error. Pre-warming serializes only that first spawn — when the
  // server is already up this is a single cheap liveness check with no added
  // latency, and its failure is swallowed so each task still surfaces its own
  // error instead of the batch throwing.
  const warmCwd = await resolveWorkspaceArg({ workspace }).catch(() => workspace);
  await ensureServerFn({ cwd: warmCwd }).catch(() => {});

  // Run every task concurrently, each as its own tracked job + OpenCode
  // session. handleDelegate never rejects (errors come back as errText), so
  // one failed task cannot take down its siblings.
  const results = await Promise.all(
    tasks.map((t, i) =>
      runDelegate(
        {
          task: t.task, model: t.model, agent: t.agent, worktree: t.worktree,
          brief: t.brief, maxWords: t.maxWords, workspace,
        },
        // Every sub-delegation registers under the BATCH's requestId, so a
        // notifications/cancelled of the batch tools/call aborts every live
        // sub-session — not just one. (oc_cancel per job still works too.)
        requestId
      ).then((r) => ({
        label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : `task ${i + 1}`,
        isError: r.isError === true,
        text: r.content?.[0]?.text ?? "",
      }))
    )
  );

  const okCount = results.filter((r) => !r.isError).length;
  const sections = results.map((r) =>
    `### ${r.label}${r.isError ? " — FAILED" : ""}\n\n${r.text}`
  );
  const out = [
    `Batch finished: ${okCount}/${results.length} succeeded.`,
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
  // Surface isError only when EVERY task failed; partial results are results.
  return okCount === 0 ? errText(out) : text(out);
}

async function handleStatus(args) {
  const workspace = await resolveWorkspaceArg(args);
  let jobs = loadState(workspace).jobs ?? [];
  jobs = await recoverStrandedResults(workspace, jobs, defaultServerUrl());
  jobs = reconcileStrandedJobs(workspace, jobs);
  const snapshot = buildStatusSnapshot(jobs, workspace, {});
  return text(renderStatus(snapshot));
}

async function handleResult(args) {
  const workspace = await resolveWorkspaceArg(args);
  const ref = typeof args.job === "string" && args.job.trim() ? args.job.trim() : undefined;
  if (ref && !/^[A-Za-z0-9._:-]+$/.test(ref)) {
    return errText("Error: invalid job reference. Use a job id or safe id prefix.");
  }
  let jobs = loadState(workspace).jobs ?? [];
  jobs = await recoverStrandedResults(workspace, jobs, defaultServerUrl());
  jobs = reconcileStrandedJobs(workspace, jobs);

  const { job, ambiguous } = resolveResultJob(jobs, ref, {});
  if (ambiguous) return errText("Error: ambiguous job reference — give a longer prefix.");
  if (!job) {
    const anyRunning = jobs.some((j) => j.status === "running" || j.status === "pending");
    return errText(anyRunning
      ? "No finished job yet — a job is still running (check oc_status; its heartbeat shows live token progress)."
      : "No finished OpenCode job found for this workspace.");
  }
  const enriched = enrichJob(job, workspace);
  const resultData = readJson(jobDataPath(workspace, job.id));
  return text(renderResult(enriched, resultData));
}

// Bound a best-effort abort so a hung (accept-but-never-answer) server can't
// wedge cancel for request()'s full 300s budget. Mirrors the Claude Code
// frontend, which wraps abortSession in a 4s timeout before moving on.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ABORT_TIMEOUT_MS = 4000;

export async function handleCancel(args, _requestId, deps = {}) {
  const makeClient = deps.createClient ?? createClient;
  const abortMs = deps.abortTimeoutMs ?? ABORT_TIMEOUT_MS;
  const workspace = await resolveWorkspaceArg(args);
  const ref = typeof args.job === "string" && args.job.trim() ? args.job.trim() : undefined;
  if (ref && !/^[A-Za-z0-9._:-]+$/.test(ref)) {
    return errText("Error: invalid job reference.");
  }
  const jobs = reconcileStrandedJobs(workspace, loadState(workspace).jobs ?? []);

  // No ref ⇒ cancel EVERY running/pending job in this workspace (cancel-all).
  // resolveCancelableJobs scopes to a session id when one is set, but Codex
  // exposes no ambient session id (getClaudeSessionId is empty unless
  // OPENCODE_COMPANION_SESSION_ID is exported), so in practice this cancels the
  // workspace's running jobs regardless of which Codex conversation started
  // them. A ref still targets exactly that one job.
  const { jobs: targets, ambiguous } = resolveCancelableJobs(jobs, ref, { sessionId: getClaudeSessionId() });
  if (ambiguous) return errText("Error: multiple running jobs — give a job id prefix.");
  if (!targets.length) return text("No active job to cancel.");

  const client = makeClient(defaultServerUrl(), { directory: workspace });
  const canceled = [];
  const alreadyDone = [];

  // (1) CAS every target to "canceled" FIRST — mirroring the CC frontend's
  // cancelJobsAndCleanup. Aborting before the CAS raced the in-flight dispatch:
  // the aborted sendPrompt returns/throws, runTrackedJob's finalize (or the
  // retry loop's shouldStop) checks the status BEFORE the CAS lands, and the
  // canceled job finalizes "completed" with a result data file — or a write
  // task re-runs on a fresh session. CAS-first makes both checks see the cancel.
  const toTearDown = [];
  for (const job of targets) {
    let finalStatus = null;
    let snapshot = null;
    updateState(workspace, (state) => {
      const j = state.jobs?.find((x) => x.id === job.id);
      if (!j) return;
      if (j.status !== "running" && j.status !== "pending") { finalStatus = j.status; return; }
      j.status = "canceled";
      j.completedAt = new Date().toISOString();
      j.errorMessage = "Canceled by user";
      j.updatedAt = new Date().toISOString();
      finalStatus = "canceled";
      // Fresh in-lock values — the caller's snapshot may be staler.
      snapshot = { id: j.id, opencodeSessionId: j.opencodeSessionId, detachedWorker: j.detachedWorker, pid: j.pid, pidStart: j.pidStart };
    });
    if (finalStatus === "canceled") { canceled.push(job.id); toTearDown.push(snapshot); }
    else if (finalStatus) alreadyDone.push(`${job.id} (${finalStatus})`);
  }

  // (2) Tear down every freshly-canceled job IN PARALLEL — sequential awaits
  // made cancel-all cost ~N × (abort timeout + kill grace) against a slow server.
  await Promise.all(toTearDown.map(async (job) => {
    // Abort the OpenCode session if we have one (returns its blocked sendPrompt).
    // Time-bounded: a hung server must not stall oc_cancel — the job is already
    // CAS-canceled, and an in-process delegation's sendPrompt unwinds on its own.
    if (job.opencodeSessionId) {
      await withTimeout(
        Promise.resolve().then(() => client.abortSession(job.opencodeSessionId)),
        abortMs,
      ).catch(() => { /* server down / slow */ });
    }
    // A detached worker only exists for jobs created by the sibling Claude Code
    // frontend sharing this store; in-process delegations have none. Ownership is
    // verified via the pid start-time fingerprint so a recycled pid is never hit.
    if (job.detachedWorker && job.pid && isOwnedProcessAlive(job.pid, job.pidStart)) {
      await terminateGroup(job.pid, { isAlive: (p) => isOwnedProcessAlive(p, job.pidStart) })
        .catch(() => { /* terminateGroup already swallows signal errors; catch for parity with the CC path */ });
    }
  }));

  const out = [];
  if (canceled.length) out.push(`Canceled ${canceled.length} job${canceled.length === 1 ? "" : "s"}: ${canceled.join(", ")}`);
  if (alreadyDone.length) out.push(`Already finished (not canceled): ${alreadyDone.join(", ")}`);
  if (!out.length) return text("No active job to cancel.");
  return text(out.join("\n"));
}

async function handleSetup() {
  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;
  let serverRunning = false;
  let providers = [];
  if (installed) {
    serverRunning = await isServerRunning();
    if (serverRunning) {
      try {
        const client = createClient(defaultServerUrl());
        const providerList = await client.listProviders();
        const list = Array.isArray(providerList) ? providerList : (providerList?.all ?? []);
        providers = list.map((p) => p.id ?? p.name).filter(Boolean);
      } catch { /* not fully ready */ }
    }
  }
  return text(renderSetup({ installed, version, serverRunning, providers }));
}

// ─── Review (read-only) ─────────────────────────────────────────────────────

async function handleReview(args, requestId) {
  return runReview(args, requestId, { adversarial: false });
}

async function handleAdversarialReview(args, requestId) {
  return runReview(args, requestId, { adversarial: true });
}

// Shared review driver. Mirrors the Claude Code frontend's handleReview /
// handleAdversarialReview but runs in-process on the 'plan' (read-only) agent
// and returns MCP content, so it also shows up in oc_status/oc_result.
async function runReview(args, requestId, { adversarial }) {
  if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim())) {
    return errText("Error: model, if supplied, must be a non-empty provider/model string.");
  }
  let base;
  if (args.base !== undefined) {
    if (typeof args.base !== "string" || !args.base.trim()) {
      return errText("Error: base, if supplied, must be a non-empty branch/ref string.");
    }
    try {
      base = assertSafeRef(args.base);
    } catch {
      return errText("Error: invalid base ref (only branch/tag/commit-ref characters are allowed).");
    }
  }
  const budget = readOutputBudget(args);
  if (budget.error) return errText(budget.error);
  const focus = adversarial && typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : undefined;
  const workspace = await resolveWorkspaceArg(args);
  const type = adversarial ? "adversarial-review" : "review";
  const label = adversarial ? "Adversarial review" : "Review";
  const job = createJobRecord(workspace, type, { base, focus, model: args.model });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      // Same model validation/auto-prefix as oc_delegate — without it a bare
      // "gpt-x" died in parseModelRef, was retried as a transport error, and
      // failed with a cryptic message instead of "Did you mean …?".
      if (args.model) {
        const refs = await client.listModelRefs().catch(() => null);
        if (refs && refs.size && !refs.has(args.model)) {
          const exact = suggestModelRefs(refs, args.model, 50).filter((r) => r.endsWith(`/${args.model}`));
          if (exact.length === 1) {
            log(`Model "${args.model}" resolved to "${exact[0]}" (added the provider prefix).`);
            args.model = exact[0];
            upsertJob(workspace, { id: job.id, requestedModel: args.model });
          } else {
            const sugg = suggestModelRefs(refs, args.model);
            throw new Error(
              `Model "${args.model}" is not available on the OpenCode server.` +
              (sugg.length ? ` Did you mean: ${sugg.join("  |  ")} ?` : "") +
              ` A ref is <providerID>/<modelID>. Run oc_setup to list the exact provider IDs.`
            );
          }
        }
      }

      // Prompt is built from the repo's git diff/status; the adversarial variant
      // reads its template from PLUGIN_ROOT/prompts/adversarial-review.md.
      // brief/maxWords here tighten the PROSE inside the schema's fields; the
      // JSON output contract itself is untouched (buildReviewPrompt keeps the
      // budget opt-in for exactly that reason).
      const prompt = await buildReviewPrompt(
        workspace,
        { base, adversarial, focus, brief: budget.brief, maxWords: budget.maxWords },
        PLUGIN_ROOT
      );

      report("reviewing", adversarial ? "Running adversarial review..." : "Running review...");
      log(`Prompt: ${prompt.length} chars${focus ? `, focus: ${focus}` : ""}${args.model ? `, model: ${args.model}` : ""}`);

      // Retry a transient 500 / empty turn / hang on a fresh session; the
      // read-only 'plan' agent guarantees the review never edits the repo.
      const dispatchedAt = Date.now(); // usage window: this run's turns only (a RESUMED session carries the previous task's turns)
      const dispatch = await dispatchWithRetry({
        client,
        prompt,
        agent: "plan",
        model: args.model,
        extract: extractResponseText,
        log,
        makeSession: () => client.createSession({ title: `${label} ${job.id}` }),
        onSession: (sid) => registerSession(requestId, workspace, job.id, sid),
        shouldStop: () => isJobCanceled(workspace, job.id) || isRequestCanceled(requestId),
      });
      const response = dispatch.response;
      const sessionId = dispatch.sessionId;
      if (dispatch.attempts > 1) log(`Succeeded on attempt ${dispatch.attempts}.`);

      report("finalizing", "Processing review output...");
      const bodyText = extractResponseText(response);
      const structured = tryParseJson(bodyText);
      // Only render as a review when the parse LOOKS like one — the brace-slice
      // fallback can latch onto an incidental JSON fragment inside prose.
      const reviewShaped = structured && (Array.isArray(structured)
        ? structured.some((x) => x && typeof x === "object")
        : (Array.isArray(structured.findings) || structured.verdict !== undefined || structured.summary !== undefined));
      const usage = await client.getSessionUsage(sessionId, { since: dispatchedAt }).catch(() => null);

      return {
        rendered: reviewShaped ? renderReview(structured) : bodyText,
        structured,
        usage,
        opencodeSessionId: sessionId,
        requestedModel: args.model,
      };
    });

    const lines = [result.rendered];
    // Same concise trailer as delegate. Reviews have no changed files; the
    // session id rides along for follow-ups and the job id lets oc_result fetch
    // the full findings later. VERBOSE_TRAILER=1 falls back to the multi-line
    // formatUsage breakdown.
    const trailer = buildResultTrailer(result.usage, {
      requestedModel: result.requestedModel,
      sessionId: result.opencodeSessionId,
      jobId: job.id,
    });
    if (trailer) lines.push(trailer);
    return text(lines.join("\n"));
  } catch (err) {
    return errText(`${label} failed (job ${job.id}): ${err.message}. If OpenCode kept running server-side, oc_result may still recover the answer.`);
  } finally {
    inflightRemove(requestId, job.id);
  }
}

// ─── Resume candidate ───────────────────────────────────────────────────────

async function handleResumeCandidate(args) {
  const workspace = await resolveWorkspaceArg(args);
  const jobs = loadState(workspace).jobs ?? [];
  const candidate = pickResumeCandidate(jobs, getClaudeSessionId());
  const head = candidate.available
    ? `Resumable OpenCode session found — pass resumeSession: "${candidate.opencodeSessionId}" to oc_delegate to continue it (job ${candidate.jobId}).`
    : "No resumable OpenCode task session for this workspace.";
  return text(`${head}\n\n${JSON.stringify(candidate)}`);
}

const HANDLERS = {
  oc_delegate: handleDelegate,
  oc_delegate_batch: handleDelegateBatch,
  oc_status: handleStatus,
  oc_result: handleResult,
  oc_cancel: handleCancel,
  oc_setup: handleSetup,
  oc_review: handleReview,
  oc_adversarial_review: handleAdversarialReview,
  oc_resume_candidate: handleResumeCandidate,
};

// ─── Response text extraction (mirrors the Claude Code frontend) ────────────

export function extractResponseText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response.parts)) {
    return response.parts
      .filter((p) => p?.type === "text")
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n");
  }
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .filter(Boolean)
        .join("\n");
    }
  }
  // UNKNOWN shape: return empty so the dispatch layer treats it as a failed
  // turn (provider-error probe + honest error) instead of a "success" whose
  // answer is a raw JSON dump.
  return "";
}

// ─── Structured-output parsing (mirrors the Claude Code frontend) ───────────

// Best-effort recovery of a JSON review payload from a model's text response:
// prefer a ```json-tagged fence, then any fence, then the first {...}/[...]
// span, then the whole string. Returns the parsed value or null.
export function tryParseJson(text) {
  if (typeof text !== "string") return null;
  const candidates = [];

  // All fenced blocks — prefer ```json-tagged ones, then any fenced block.
  const fences = [...text.matchAll(/```(json)?\s*\n([\s\S]*?)```/g)];
  for (const m of fences) {
    if (m[1]) candidates.push(m[2]); // json-tagged first
  }
  for (const m of fences) {
    if (!m[1]) candidates.push(m[2]);
  }
  // Bare object/array spanning the first "{"/"[" to the last "}"/"]".
  const braceStart = text.search(/[[{]/);
  if (braceStart !== -1) {
    const braceEnd = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (braceEnd > braceStart) candidates.push(text.slice(braceStart, braceEnd + 1));
  }
  candidates.push(text); // last resort: the whole thing

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ─── Resume-candidate selection (mirrors the Claude Code frontend) ──────────

// Pick the most recent resumable OpenCode task session from a job list: a
// completed/running "task" job that carries an opencodeSessionId. When a
// sessionId is supplied, restrict to that owner's jobs; otherwise consider all
// (Codex runs typically have no session id, so this scans the whole workspace).
export function pickResumeCandidate(jobs, sessionId) {
  const lastTask = (jobs ?? [])
    .filter((j) => j && j.type === "task" && j.opencodeSessionId)
    .filter((j) => j.status === "completed" || j.status === "running")
    .filter((j) => !sessionId || j.sessionId === sessionId)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
  return {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };
}

// ─── Message dispatch ───────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "notifications/cancelled") {
    // Cancel the in-flight delegation(s) tied to this request: mark the job
    // canceled (so an in-flight dispatch sees it via shouldStop and does not
    // re-run on a fresh session) and abort its OpenCode session so sendPrompt
    // returns. One entry for a single delegation; MANY for a batch (all its
    // sub-sessions share the batch requestId) — abort EVERY one.
    const reqId = msg.params?.requestId;
    // Record the cancel BEFORE snapshotting inflight: a sub-delegation whose
    // session registers after this point then self-cancels in registerSession
    // instead of slipping past this one-shot snapshot and running to completion.
    noteRequestCanceled(reqId);
    const entries = inflight.get(reqId);
    if (entries && entries.length) {
      inflight.delete(reqId);
      for (const entry of entries) {
        markJobCanceled(entry.workspace, entry.jobId);
        await abortSessionBounded(entry.workspace, entry.sessionId);
      }
    }
    return;
  }
  if (!msg.method || msg.id === undefined) return;

  switch (msg.method) {
    case "initialize": {
      sendResponse(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "opencode-companion", version: SERVER_VERSION },
        instructions:
          "OpenCode Companion: call oc_delegate directly and let its foreground tools/call remain pending until completion — do not emulate it through shell, poll it, or emit periodic waiting commentary. Long tasks (15-30+ min) are normal; oc_status shows a live token heartbeat. If a run is interrupted, oc_result recovers a finished answer from the OpenCode server.",
      });
      break;
    }
    case "tools/list":
      sendResponse(msg.id, { tools: TOOLS });
      break;
    case "tools/call": {
      const params = msg.params && typeof msg.params === "object" ? msg.params : null;
      if (!params) return sendError(msg.id, -32602, "Invalid params: expected object");
      const handler = HANDLERS[params.name];
      if (!handler) return sendError(msg.id, -32601, `Unknown tool: ${params.name}`);
      const toolArgs = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      // Reject unknown argument keys instead of silently dropping them. A typo'd
      // key ({bsae: "main"}) used to make oc_review silently review the WORKING
      // TREE instead of the intended branch — the exact bug class the CC CLI
      // fixed with strict parsing in 2.3.6.
      const badKeys = unknownToolArgKeys(params.name, toolArgs);
      if (badKeys.length) {
        sendResponse(msg.id, errText(
          `Error: unknown argument${badKeys.length === 1 ? "" : "s"} for ${params.name}: ${badKeys.join(", ")}. ` +
          `Allowed: ${[...allowedToolArgKeys(params.name)].join(", ")}.`
        ));
        break;
      }
      try {
        const result = await handler(toolArgs, msg.id);
        sendResponse(msg.id, result);
      } catch (err) {
        sendResponse(msg.id, errText(`Tool ${params.name} failed: ${err.message}`));
      }
      break;
    }
    case "ping":
      sendResponse(msg.id, {});
      break;
    default:
      sendError(msg.id, -32601, `Unknown method: ${msg.method}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      logErr(`Failed to parse JSON-RPC message: ${err.message}`);
      return;
    }
    void handleMessage(msg).catch((err) => logErr(`handleMessage error: ${err.message}`));
  });
  rl.on("close", () => process.exit(0));
}

// Only start the stdio JSON-RPC loop when run as the entry script. Guarding this
// lets tests import the handlers (and their injectable seams) without spawning
// the server on stdin. realpath both sides so a symlinked launch still matches.
function isEntryPoint() {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
