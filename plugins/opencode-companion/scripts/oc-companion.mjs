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

import { isOpencodeInstalled, getOpencodeVersion } from "./lib/process.mjs";
import { isServerRunning, connect, createClient } from "./lib/opencode-server.mjs";
import { loadState, updateState, upsertJob, jobDataPath } from "./lib/state.mjs";
import {
  buildStatusSnapshot,
  resolveResultJob,
  resolveCancelableJob,
  enrichJob,
  reconcileStrandedJobs,
  recoverStrandedResults,
  isOwnedProcessAlive,
} from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderSetup, formatUsage } from "./lib/render.mjs";
import { buildTaskPrompt } from "./lib/prompts.mjs";
import { withWorktree } from "./lib/worktree.mjs";
import { readJson } from "./lib/fs.mjs";

const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-03-26";

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

// requestId → { sessionId, jobId, workspace } for notifications/cancelled.
const inflight = new Map();

// ─── Workspace ──────────────────────────────────────────────────────────────

function resolveWorkspaceArg(args) {
  const ws = typeof args.workspace === "string" && args.workspace.trim()
    ? path.resolve(args.workspace.trim())
    : process.cwd();
  return ws;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "oc_delegate",
    description:
      "Delegate a coding task to OpenCode (running on any OpenAI-compatible backend) and BLOCK until it finishes, returning the full result plus a token-usage line. This single call is the whole delegation: do not poll, sleep, or emit waiting commentary while it is pending. Long tasks (15-30+ min) are normal.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The full task text, verbatim and self-contained. OpenCode sees ONLY this text plus the repository — restate any context it needs." },
        model: { type: "string", description: "Optional provider/model ref (split on the FIRST slash; model ids may contain slashes). Omit for the provider default." },
        agent: { type: "string", enum: ["build", "plan"], description: "OpenCode agent. 'build' (default) has full write access; 'plan' is the ONLY read-only mode." },
        worktree: { type: "boolean", description: "Run a write-capable task in an isolated throwaway git worktree and apply the changes back (protects concurrent edits in the live repo)." },
        resumeSession: { type: "string", description: "Explicit OpenCode session id to continue instead of starting fresh." },
        workspace: { type: "string", description: "Absolute path of the repository/workspace to operate in. Defaults to the server's cwd." },
      },
      required: ["task"],
    },
  },
  {
    name: "oc_delegate_batch",
    description:
      "Delegate SEVERAL independent coding tasks to OpenCode IN PARALLEL with a single call, blocking until ALL finish, and return every result. Use this instead of multiple oc_delegate calls whenever you have 2+ independent tasks (e.g. fanning out to different models or reviewing different modules) — the host executes MCP tools sequentially, so batching is the only way to get true parallelism. Same no-polling rule as oc_delegate.",
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
    description: "Cancel a running OpenCode job: aborts its OpenCode session and marks the job canceled (never clobbers an already-finished result).",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Job id or unique prefix. Omit for the most recent running job." },
        workspace: { type: "string", description: "Workspace path. Defaults to the server's cwd." },
      },
    },
  },
  {
    name: "oc_setup",
    description: "Check whether OpenCode is installed, its server is reachable, and which providers are configured.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleDelegate(args, requestId) {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return errText("Error: task is required and must be a non-empty string.");
  if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim())) {
    return errText("Error: model, if supplied, must be a non-empty provider/model string.");
  }
  const agentName = args.agent === "plan" ? "plan" : "build";
  const isWrite = agentName !== "plan";
  const useWorktree = !!args.worktree && isWrite;
  const workspace = resolveWorkspaceArg(args);
  const resumeSessionId = typeof args.resumeSession === "string" && args.resumeSession.trim()
    ? args.resumeSession.trim()
    : null;

  const job = createJobRecord(workspace, "task", { agent: agentName, resumeSessionId });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) =>
      withWorktree({ dir: workspace, jobId: job.id, useWorktree, isWrite }, async (effectiveCwd) => {
        report("starting", "Connecting to OpenCode server...");
        const client = await connect({ cwd: effectiveCwd });

        let sessionId;
        if (resumeSessionId) {
          sessionId = resumeSessionId;
          report("starting", `Resuming session ${sessionId}...`);
        } else {
          const session = await client.createSession({ title: `Codex delegate ${job.id}` });
          sessionId = session.id;
          report("starting", `Created session ${sessionId}`);
        }
        upsertJob(workspace, { id: job.id, opencodeSessionId: sessionId });
        if (requestId !== undefined) inflight.set(requestId, { sessionId, jobId: job.id, workspace });

        const prompt = buildTaskPrompt(task, { write: isWrite });
        report("investigating", "Running task...");
        log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${prompt.length} chars, Model: ${args.model ?? "(provider default)"}`);

        // Token-progress heartbeat: lets oc_status distinguish "generating"
        // (tokens climbing) from "stuck" (frozen) during a long blocking run.
        const heartbeat = setInterval(async () => {
          const u = await client.getSessionUsage(sessionId, { timeoutMs: 8_000 }).catch(() => null);
          if (u && u.total > 0) {
            log(`heartbeat: ${u.total.toLocaleString()} tokens so far (${u.turns} turn${u.turns === 1 ? "" : "s"})`);
          }
        }, 30_000);
        heartbeat.unref?.();

        let response;
        try {
          response = await client.sendPrompt(sessionId, prompt, {
            agent: agentName,
            model: args.model,
          });
        } finally {
          clearInterval(heartbeat);
        }

        const bodyText = extractResponseText(response);
        const usage = await client.getSessionUsage(sessionId).catch(() => null);

        let changedFiles = [];
        if (isWrite) {
          try {
            const diff = await client.getSessionDiff(sessionId);
            if (diff?.files) changedFiles = diff.files.map((f) => f.path || f.name).filter(Boolean);
          } catch { /* diff endpoint may be unavailable */ }
        }

        report("finalizing", "Done");
        return { rendered: bodyText, usage, changedFiles, summary: bodyText.slice(0, 500), opencodeSessionId: sessionId };
      })
    );

    const lines = [result.rendered];
    const usageLine = formatUsage(result.usage);
    if (usageLine) lines.push(`\n---\n${usageLine}`);
    if (result.changedFiles?.length) {
      lines.push(`\nChanged files:\n${result.changedFiles.map((f) => `- ${f}`).join("\n")}`);
    }
    lines.push(`\n[job ${job.id} · session ${result.opencodeSessionId} — resumable via resumeSession]`);
    return text(lines.join("\n"));
  } catch (err) {
    return errText(`Delegation failed (job ${job.id}): ${err.message}. If OpenCode kept running server-side, oc_result may still recover the answer.`);
  } finally {
    if (requestId !== undefined) inflight.delete(requestId);
  }
}

async function handleDelegateBatch(args, requestId) {
  const tasks = Array.isArray(args.tasks) ? args.tasks : null;
  if (!tasks || tasks.length === 0) {
    return errText("Error: tasks must be a non-empty array of { task, model?, agent?, worktree?, label? }.");
  }
  for (const [i, t] of tasks.entries()) {
    if (!t || typeof t.task !== "string" || !t.task.trim()) {
      return errText(`Error: tasks[${i}].task is required and must be a non-empty string.`);
    }
  }
  const workspace = typeof args.workspace === "string" ? args.workspace : undefined;

  // Run every task concurrently, each as its own tracked job + OpenCode
  // session. handleDelegate never rejects (errors come back as errText), so
  // one failed task cannot take down its siblings.
  const results = await Promise.all(
    tasks.map((t, i) =>
      handleDelegate(
        { task: t.task, model: t.model, agent: t.agent, worktree: t.worktree, workspace },
        undefined // batch-level cancellation is handled via oc_cancel per job
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
  const workspace = resolveWorkspaceArg(args);
  let jobs = loadState(workspace).jobs ?? [];
  jobs = await recoverStrandedResults(workspace, jobs, defaultServerUrl());
  jobs = reconcileStrandedJobs(workspace, jobs);
  const snapshot = buildStatusSnapshot(jobs, workspace, {});
  return text(renderStatus(snapshot));
}

async function handleResult(args) {
  const workspace = resolveWorkspaceArg(args);
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

async function handleCancel(args) {
  const workspace = resolveWorkspaceArg(args);
  const ref = typeof args.job === "string" && args.job.trim() ? args.job.trim() : undefined;
  if (ref && !/^[A-Za-z0-9._:-]+$/.test(ref)) {
    return errText("Error: invalid job reference.");
  }
  const jobs = reconcileStrandedJobs(workspace, loadState(workspace).jobs ?? []);
  const { job, ambiguous } = resolveCancelableJob(jobs, ref, {});
  if (ambiguous) return errText("Error: multiple running jobs — give a job id prefix.");
  if (!job) return text("No active job to cancel.");

  if (job.opencodeSessionId) {
    try {
      const client = createClient(defaultServerUrl(), { directory: workspace });
      await client.abortSession(job.opencodeSessionId);
    } catch { /* server may be down */ }
  }
  // A detached worker only exists for jobs created by the sibling Claude Code
  // frontend sharing this store; in-process delegations have none.
  if (job.detachedWorker && job.pid && isOwnedProcessAlive(job.pid, job.pidStart)) {
    try { process.kill(job.pid, "SIGTERM"); } catch { /* gone */ }
  }
  let finalStatus = null;
  updateState(workspace, (state) => {
    const j = state.jobs?.find((x) => x.id === job.id);
    if (!j) return;
    if (j.status !== "running" && j.status !== "pending") { finalStatus = j.status; return; }
    j.status = "canceled";
    j.completedAt = new Date().toISOString();
    j.errorMessage = "Canceled by user";
    j.updatedAt = new Date().toISOString();
    finalStatus = "canceled";
  });
  if (finalStatus && finalStatus !== "canceled") {
    return text(`Job ${job.id} already ${finalStatus}; nothing to cancel.`);
  }
  return text(`Canceled job: ${job.id}`);
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

const HANDLERS = {
  oc_delegate: handleDelegate,
  oc_delegate_batch: handleDelegateBatch,
  oc_status: handleStatus,
  oc_result: handleResult,
  oc_cancel: handleCancel,
  oc_setup: handleSetup,
};

// ─── Response text extraction (mirrors the Claude Code frontend) ────────────

function extractResponseText(response) {
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
  return JSON.stringify(response, null, 2);
}

// ─── Message dispatch ───────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "notifications/cancelled") {
    // Cancel the in-flight delegation tied to this request: abort its OpenCode
    // session so sendPrompt returns; the job is finalized by its own error path.
    const reqId = msg.params?.requestId;
    const entry = inflight.get(reqId);
    if (entry) {
      inflight.delete(reqId);
      try {
        const client = createClient(defaultServerUrl(), { directory: entry.workspace });
        await client.abortSession(entry.sessionId);
      } catch { /* best-effort */ }
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

main();
