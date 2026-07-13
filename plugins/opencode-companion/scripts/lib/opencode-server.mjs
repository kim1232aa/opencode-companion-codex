// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

// Read the port from the same env var the CLI's defaultServerUrl() uses, so
// dispatch (connect/ensureServer) and recovery/cancel probes always agree on
// which port the server lives on.
const DEFAULT_PORT = Number(process.env.OPENCODE_SERVER_PORT) || 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Long prompts must NOT go through global fetch(): Node's bundled undici
// enforces a hidden 300_000 ms default bodyTimeout that kills the socket
// mid-response (surfacing as an opaque "fetch failed" / "terminated")
// well before any AbortSignal.timeout we set — so a >5 min task on a slow
// model dies at exactly 5m00s. node:http has no such default, so the
// prompt POST goes through httpPostJson() below and is bounded only by the
// explicit wall-clock timer we pass. (Approach harvested from the
// JohnnyVicious/opencode-plugin-cc fork, which hit the same bug.)
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

function resolvePromptTimeoutMs() {
  const fromEnv = Number(process.env.OPENCODE_COMPANION_PROMPT_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_PROMPT_TIMEOUT_MS;
}

/**
 * POST a JSON body via node:http/https (NOT fetch) and return the raw
 * response, bounded only by an explicit wall-clock timer.
 * @param {string} urlString
 * @param {Record<string,string>} headers
 * @param {unknown} bodyObj
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, body: string }>}
 */
function httpPostJson(urlString, headers, bodyObj, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : resolvePromptTimeoutMs();
  const url = new URL(urlString);
  const lib = url.protocol === "https:" ? https : http;
  const payload = Buffer.from(JSON.stringify(bodyObj), "utf8");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method: "POST",
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, "Content-Length": payload.length },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => finish(resolve, { status: res.statusCode ?? 0, body: data }));
        res.on("error", (err) => finish(reject, err));
      }
    );

    req.on("error", (err) => finish(reject, err));
    timer = setTimeout(() => {
      finish(reject, new Error(
        `OpenCode prompt exceeded ${Math.round(timeoutMs / 1000)}s wall-clock timeout ` +
          `(raise OPENCODE_COMPANION_PROMPT_TIMEOUT_MS to allow longer tasks)`
      ));
      req.destroy();
    }, timeoutMs);

    // req.write/req.end can throw synchronously (e.g. socket already destroyed);
    // route that into the promise instead of leaking it and hanging until timeout.
    try {
      req.write(payload);
      req.end();
    } catch (err) {
      finish(reject, err);
    }
  });
}

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    // Identity check: a foreign service squatting on the port could also answer
    // 200 here. OpenCode's /global/health returns { healthy: true, version }.
    // Require healthy === true (so a { healthy: false } server isn't treated as
    // ready), tolerating a version-only body for builds that omit `healthy`, and
    // fail closed on a non-JSON / unrecognized body so we never dispatch into an
    // unrelated service.
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") return false;
    return body.healthy === true || (body.healthy == null && typeof body.version === "string");
  } catch {
    return false;
  }
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://${host}:${port}`;

  if (await isServerRunning(host, port)) {
    return { url, alreadyRunning: true };
  }

  // Start the server
  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: opts.cwd,
    // websearch is otherwise a no-op on custom (non-"opencode/*") providers
    // unless this is set — see https://opencode.ai/docs/tools/
    env: { ...process.env, OPENCODE_ENABLE_EXA: "1" },
  });

  // Drain stdout/stderr into a bounded tail buffer. Two reasons: (1) leaving
  // "pipe" without a reader lets the OS pipe buffer fill and BLOCK the child
  // (a latent hang); (2) capturing the tail lets us surface *why* startup
  // failed instead of an opaque timeout.
  let diagTail = "";
  const drain = (chunk) => {
    diagTail = (diagTail + chunk.toString()).slice(-2000);
  };
  proc.stdout?.on("data", drain);
  proc.stderr?.on("data", drain);
  let spawnError = null;
  let earlyExit = null;
  proc.on("error", (err) => { spawnError = err; });
  // If the server process dies during startup (bad config, port already bound,
  // auth failure, …) fail fast with its exit code + captured output instead of
  // burning the full 30s timeout.
  proc.on("exit", (code, signal) => {
    if (code !== 0) earlyExit = { code, signal };
  });
  proc.unref();

  // The stdout/stderr pipes are open handles held by THIS process; proc.unref()
  // alone does not release them, so after a cold start the dispatcher would
  // finish its work and then hang forever instead of exiting. Destroy them once
  // we no longer need startup diagnostics.
  const releasePipes = () => {
    try { proc.stdout?.destroy(); } catch { /* already closed */ }
    try { proc.stderr?.destroy(); } catch { /* already closed */ }
  };

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (spawnError) {
      releasePipes();
      throw new Error(`Failed to spawn 'opencode serve': ${spawnError.message}`);
    }
    if (earlyExit) {
      const detail = diagTail.trim() ? `\nOutput:\n${diagTail.trim()}` : "";
      releasePipes();
      throw new Error(`'opencode serve' exited early (code ${earlyExit.code}${earlyExit.signal ? `, signal ${earlyExit.signal}` : ""}) before becoming ready.${detail}`);
    }
    if (await isServerRunning(host, port)) {
      releasePipes();
      return { url, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Startup timed out: kill the half-started child so it doesn't linger trying
  // to bind the port (a later call would then see a confusing "already running").
  try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  releasePipes();
  const detail = diagTail.trim() ? `\nLast output:\n${diagTail.trim()}` : "";
  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s${detail}`);
}

/**
 * Convert a CLI-style "provider/model" string into the {providerID, modelID}
 * object the OpenCode REST API requires. Only the first slash is significant
 * so custom-provider model IDs that themselves contain slashes still round-trip.
 * @param {string} modelRef
 * @returns {{ providerID: string, modelID: string }}
 */
export function parseModelRef(modelRef) {
  const ref = String(modelRef).trim();
  const idx = ref.indexOf("/");
  const providerID = idx === -1 ? "" : ref.slice(0, idx);
  const modelID = idx === -1 ? "" : ref.slice(idx + 1);
  if (!providerID || !modelID) {
    throw new Error(`--model must be in the form provider/model, got: ${modelRef}`);
  }
  return { providerID, modelID };
}

const PERMISSION_POLL_INTERVAL_MS = 3000;

/**
 * Poll GET /permission and auto-reject any pending request for this session.
 *
 * OpenCode's permission gate (e.g. "external_directory" for paths outside the
 * session's own workspace) defaults to asking for interactive approval. This
 * companion runtime has no human attached to answer that ask, so left alone
 * the session hangs until the outer request's own timeout (5-10 min) finally
 * fails it with an opaque error. Since nothing can ever answer the prompt in
 * this headless context, reject on first sighting instead of waiting — the
 * agent gets a normal tool-error it can react to (retry differently, or just
 * report the limitation) rather than the whole dispatch dying silently.
 *
 * @param {string} baseUrl
 * @param {Record<string,string>} headers
 * @param {string} sessionId
 * @returns {{ stop: () => void }}
 */
function watchAndRejectPermissions(baseUrl, headers, sessionId) {
  let stopped = false;
  const handled = new Set();

  (async () => {
    while (!stopped) {
      try {
        const res = await fetch(`${baseUrl}/permission`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const raw = await res.json();
          const pending = Array.isArray(raw) ? raw : (raw?.permissions ?? []);
          for (const p of pending) {
            if (p.sessionID !== sessionId || handled.has(p.id)) continue;
            const patterns = Array.isArray(p.patterns) ? p.patterns.join(", ") : "";
            try {
              const reply = await fetch(`${baseUrl}/permission/${p.id}/reply`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  reply: "reject",
                  message: `Auto-rejected by opencode-companion: this is a headless dispatch with no one able to approve a "${p.permission}" prompt${patterns ? ` (${patterns})` : ""}.`,
                }),
                signal: AbortSignal.timeout(5000),
              });
              // Only mark handled once the reject is accepted (or terminally
              // 4xx = already resolved). A transient 5xx/network failure leaves
              // it unhandled so the next poll retries instead of stranding it.
              if (reply.ok || (reply.status >= 400 && reply.status < 500)) {
                handled.add(p.id);
              } else {
                process.stderr.write(`[opencode-companion] permission reject for ${p.id} got HTTP ${reply.status}; will retry\n`);
              }
            } catch (err) {
              process.stderr.write(`[opencode-companion] permission reject for ${p.id} failed (${err.message}); will retry\n`);
            }
          }
        }
      } catch {
        // Transient poll failure — try again next tick.
      }
      await new Promise((r) => setTimeout(r, PERMISSION_POLL_INTERVAL_MS));
    }
  })();

  return { stop: () => { stopped = true; } };
}

/**
 * Create an API client bound to a running OpenCode server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory for x-opencode-directory header
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.directory) {
    // Header values must be ASCII AND free of control chars: non-ASCII (e.g. a
    // Chinese directory name) or a control char (\r\n — a path CAN legally
    // contain them on Linux) would make Headers/undici throw and crash every
    // request. Percent-encode when either is present; the server decodes.
    headers["x-opencode-directory"] = /[^\x20-\x7E]/.test(opts.directory)
      ? encodeURIComponent(opts.directory)
      : opts.directory;
  }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  async function request(method, path, body, timeoutMs = 300_000) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    // On a busy shared daemon (multiple Claude Code windows dispatching
    // concurrently), session creation can queue behind other work for minutes.
    // It MUST go through httpPostJson (node:http) rather than fetch: undici's
    // hidden 300s bodyTimeout would otherwise kill it at 5m00s regardless of
    // any AbortSignal we set — the same trap sendPrompt avoids.
    createSession: async (opts = {}) => {
      const { status, body } = await httpPostJson(`${baseUrl}/session`, headers, opts);
      if (status < 200 || status >= 300) {
        throw new Error(`OpenCode API POST /session returned ${status}: ${body}`);
      }
      try {
        return JSON.parse(body);
      } catch (err) {
        throw new Error(`OpenCode createSession returned non-JSON (${status}): ${err.message}`);
      }
    },
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", `/session/${id}/abort`),
    getSessionStatus: () => request("GET", "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before) params.set("before", opts.before);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`);
    },

    /**
     * Sum token usage + cost across all assistant messages in a session.
     * Each message's info.tokens is per-turn, so a multi-step agent loop needs
     * them summed for the true session total. Returns null on failure.
     */
    getSessionUsage: async (sessionId, opts = {}) => {
      const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 300_000;
      try {
        const msgs = await request("GET", `/session/${sessionId}/message`, undefined, timeoutMs);
        const list = Array.isArray(msgs) ? msgs : [];
        const acc = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, model: null };
        for (const m of list) {
          const info = m?.info;
          if (!info || info.role !== "assistant") continue;
          const t = info.tokens || {};
          const input = t.input || 0;
          const output = t.output || 0;
          const reasoning = t.reasoning || 0;
          const cacheRead = t.cache?.read || 0;
          const cacheWrite = t.cache?.write || 0;
          // Some opencode builds omit tokens.total; derive it when missing.
          const total = t.total || input + output + reasoning + cacheRead + cacheWrite;
          acc.total += total;
          acc.input += input;
          acc.output += output;
          acc.reasoning += reasoning;
          acc.cacheRead += cacheRead;
          acc.cacheWrite += cacheWrite;
          // Lenient parse: some builds serialize cost as a numeric string
          // (e.g. "0.0123" from a DB TEXT column); Number() handles both and
          // Number.isFinite filters undefined/null/garbage.
          const cost = Number(info.cost);
          if (Number.isFinite(cost)) acc.cost += cost;
          acc.turns += 1;
          // Record the model that ACTUALLY ran (last assistant turn wins), so
          // callers can report requested-vs-observed and catch a silent default.
          if (info.providerID && info.modelID) {
            acc.model = `${info.providerID}/${info.modelID}`;
          }
        }
        return acc;
      } catch {
        return null;
      }
    },

    /**
     * Probe a session's final answer directly from the server, to salvage the
     * result of a job whose worker died AFTER the prompt was sent but the
     * OpenCode session kept running server-side.
     *
     * Returns { text, active }:
     *  - text:   the latest COMPLETED, error-free assistant turn (time.completed
     *            set, info.error absent) that is newer than opts.since — or null.
     *  - active: true if the server still appears to be generating our answer
     *            (an in-progress assistant turn, or a trailing user message with
     *            no completed reply yet). Lets the caller keep waiting instead of
     *            failing the job or recovering a half-finished turn.
     *
     * opts.since (epoch ms) filters out turns from before this task was
     * dispatched — critical for a reused --resume-last session that still
     * carries the previous task's answer. opts.timeoutMs bounds the fetch.
     * @param {string} sessionId
     * @param {{ since?: number, timeoutMs?: number }} [opts]
     * @returns {Promise<{ text: string|null, active: boolean }>}
     */
    getSessionResult: async (sessionId, opts = {}) => {
      const since = typeof opts.since === "number" && opts.since > 0 ? opts.since : 0;
      const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 300_000;
      try {
        const msgs = await request("GET", `/session/${sessionId}/message`, undefined, timeoutMs);
        const list = Array.isArray(msgs) ? msgs : [];
        let doneText = null;
        let active = false;
        for (const m of list) {
          const info = m?.info;
          if (!info || info.role !== "assistant") continue;
          const created = info.time?.created ?? 0;
          // When a dispatch-time filter is active, a message with a MISSING
          // timestamp must be treated as pre-dispatch (skip) — otherwise an old
          // turn whose backend omitted time.created would slip past the filter
          // and be recovered as the current task's answer.
          if (since && (!created || created < since)) continue;
          const parts = Array.isArray(m.parts) ? m.parts : [];
          const text = parts
            .filter((p) => p?.type === "text")
            .map((p) => p.text)
            .filter(Boolean) // a text part missing .text must not become "undefined"
            .join("\n")
            .trim();
          const completed = !!info.time?.completed;
          const errored = info.error != null;
          if (completed && !errored && text) {
            doneText = text; // keep the latest completed, error-free turn
          } else if (!completed && !errored) {
            active = true; // an in-progress turn ⇒ the server is still generating
          }
        }
        if (!doneText && !active) {
          // A trailing user message newer than `since` with no answer yet also
          // means the server is still working on our prompt.
          const last = list[list.length - 1]?.info;
          if (last?.role === "user" && (!since || (last.time?.created ?? 0) >= since)) active = true;
        }
        return { text: doneText, active };
      } catch {
        return { text: null, active: false };
      }
    },

    /**
     * Send a prompt (synchronous / streaming).
     * Returns the full response text from SSE stream.
     */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = parseModelRef(opts.model);
      if (opts.system) body.system = opts.system;

      const permissionWatcher = watchAndRejectPermissions(baseUrl, headers, sessionId);
      let status, responseText;
      try {
        // node:http, not fetch — see httpPostJson / undici bodyTimeout note above.
        ({ status, body: responseText } = await httpPostJson(
          `${baseUrl}/session/${sessionId}/message`,
          headers,
          body
        ));
      } finally {
        permissionWatcher.stop();
      }

      if (status < 200 || status >= 300) {
        throw new Error(`OpenCode prompt failed ${status}: ${responseText}`);
      }

      try {
        return JSON.parse(responseText);
      } catch (err) {
        throw new Error(`OpenCode prompt returned non-JSON response (${status}): ${err.message}`);
      }
    },

    // Agents
    listAgents: () => request("GET", "/agent"),

    // Providers
    listProviders: () => request("GET", "/provider"),

    /**
     * All valid model refs the server knows, as a Set of "<providerID>/<modelID>"
     * strings. providerID is the OpenCode provider (e.g. "volcano-coding"); the
     * modelID may itself contain slashes (e.g. "火山方舟Coding_Plan/glm-5.2"), so a
     * full ref can have several slashes. Used to validate --model before dispatch
     * and to suggest the right ref when the caller drops the provider prefix.
     * @returns {Promise<Set<string>>}
     */
    listModelRefs: async () => {
      const r = await request("GET", "/provider");
      const providers = Array.isArray(r) ? r : (r?.all ?? []);
      const refs = new Set();
      for (const p of providers) {
        const pid = p?.id ?? p?.name;
        if (!pid || !p?.models) continue;
        for (const modelId of Object.keys(p.models)) refs.add(`${pid}/${modelId}`);
      }
      return refs;
    },

    // Config
    getConfig: () => request("GET", "/config"),

    // NOTE: sendPromptAsync / getProviderAuth / subscribeEvents were removed —
    // they had zero callers and inconsistent option/error handling (e.g. a
    // silently-ignored `system` option, no res.ok check on the SSE stream),
    // which made them a false capability surface for future callers.
  };
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url } };
}

/**
 * Given the server's valid model refs and a (possibly malformed) requested ref,
 * suggest the closest correct full refs — chiefly when the caller passed the
 * modelID without the provider prefix (e.g. "商汤/glm-5.2" instead of
 * "volcano-coding/商汤/glm-5.2"). Returns up to `limit` suggestions, best first.
 * @param {Set<string>|string[]} allRefs
 * @param {string} requested
 * @param {number} [limit]
 * @returns {string[]}
 */
export function suggestModelRefs(allRefs, requested, limit = 5) {
  const refs = Array.isArray(allRefs) ? allRefs : Array.from(allRefs ?? []);
  const q = String(requested ?? "").trim();
  if (!q) return [];
  const tail = q.slice(q.indexOf("/") + 1); // model part if a slash is present
  const scored = [];
  for (const r of refs) {
    if (r === q) return [r]; // exact — already valid
    let score = 0;
    if (r.endsWith(`/${q}`)) score = 100;              // just missing provider prefix
    else if (r.endsWith(`/${tail}`)) score = 60;        // same model id, different group
    else if (r.includes(q)) score = 40;
    else if (tail && r.includes(tail)) score = 20;
    if (score) scored.push([score, r]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
  return scored.slice(0, limit).map(([, r]) => r);
}
