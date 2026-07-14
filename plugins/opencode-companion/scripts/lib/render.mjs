// Output rendering for the OpenCode companion.

// A run can finish with status "completed" yet produce NO usable text (a model
// that returns an empty turn — observed with some combo-router models). That is
// NOT a success; surface it explicitly so status/result judgment isn't fooled.
export const EMPTY_RESULT_WARNING =
  "### ⚠️ No output\n\nThe run finished but the model produced NO usable output " +
  "(an empty response). This is NOT a successful result — the model may be " +
  "misconfigured or unsuitable for this task. Try a different --model or rephrase the task.";

/**
 * True when a job finished successfully-shaped but its result text is blank.
 * @param {object} [resultData]
 * @returns {boolean}
 */
export function isEmptyResult(resultData) {
  if (!resultData) return true;
  if (typeof resultData.rendered === "string" && resultData.rendered.trim()) return false;
  if (typeof resultData.summary === "string" && resultData.summary.trim()) return false;
  if (Array.isArray(resultData.messages)) {
    const last = resultData.messages.filter((m) => m.role === "assistant").pop();
    if (last && extractMessageText(last).trim()) return false;
  }
  return true;
}
/**
 * Render a status snapshot as human-readable text.
 * @param {{ running: object[], latestFinished: object|null, recent: object[] }} snapshot
 * @returns {string}
 */
// Pull the live signal out of a running job's log tail: the newest heartbeat
// token count and how long ago the newest log line was written (staleness).
// Lets a caller tell "generating" (tokens up / fresh) from "stuck" (stale) from
// "done/errored" — the exact judgment that a bare "running" label can't give.
function liveSignal(progressPreview) {
  if (typeof progressPreview !== "string" || !progressPreview) return {};
  const lines = progressPreview.split("\n").filter(Boolean);
  let tokens = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/heartbeat:\s*([\d,]+)\s*tokens/i);
    if (m) { tokens = m[1]; break; }
  }
  let ageSec = null;
  const lastTs = lines[lines.length - 1]?.match(/^\[([^\]]+)\]/)?.[1];
  const t = lastTs ? Date.parse(lastTs) : NaN;
  if (Number.isFinite(t)) ageSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  return { tokens, ageSec };
}

// Pull the last few "activity:" lines out of a running job's log tail — the
// internal tool calls (bash/edit/read …) that dispatchWithRetry records — so
// status can show what OpenCode is doing, not just a token count. Kept to a
// small `max` so the preview never floods.
function recentActivity(progressPreview, max = 2) {
  if (typeof progressPreview !== "string" || !progressPreview) return [];
  const lines = progressPreview.split("\n").filter(Boolean);
  const acts = [];
  for (let i = lines.length - 1; i >= 0 && acts.length < max; i--) {
    const m = lines[i].match(/\bactivity:\s*(.+?)\s*$/);
    if (m) acts.unshift(m[1]);
  }
  return acts;
}

const STATUS_ICON = {
  running: "🟢", pending: "🟡", completed: "✅", failed: "❌", canceled: "⛔",
};

function statusLine(j) {
  const icon = STATUS_ICON[j.status] ?? "•";
  const empty = j.emptyResult && (j.status === "completed") ? " ⚠️ no output" : "";
  return `- ${icon} **${j.id}** (${j.type}) — ${j.status}${empty} — ${j.elapsed ?? "just started"}`;
}

export function renderStatus(snapshot) {
  const lines = [];
  const running = Array.isArray(snapshot.running) ? snapshot.running : [];
  const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];

  if (running.length > 0) {
    lines.push(`## Running Jobs (${running.length})\n`);
    for (const job of running) {
      const { tokens, ageSec } = liveSignal(job.progressPreview);
      const bits = [`${STATUS_ICON[job.status] ?? "🟢"} **${job.id}** (${job.type})`, job.phase ?? "running", job.elapsed ?? "just started"];
      if (tokens) bits.push(`${tokens} tokens`);
      if (ageSec != null) bits.push(`updated ${ageSec}s ago${ageSec > 120 ? " ⚠️ possibly stuck" : ""}`);
      lines.push(`- ${bits.join(" · ")}`);
      // Show the last 1-2 internal tool calls (bash/edit/read …) instead of
      // dumping the raw log tail — approximates a native subagent's visibility
      // into what the delegate is running, without flooding the status view.
      const acts = recentActivity(job.progressPreview, 2);
      for (const a of acts) lines.push(`  ↳ ${a}`);
    }
    lines.push("");
    lines.push("_Tokens rising between two checks = generating. Same tokens + a large \"updated … ago\" = stuck. Failed/❌ or ⚠️ no-output = did not succeed._");
    lines.push("");
  }

  // Any FAILED job among the recent set gets surfaced up front — a mid-run
  // error otherwise hides at the bottom while you watch the runners.
  const failed = recent.filter((j) => j.status === "failed");
  if (failed.length > 0) {
    lines.push(`## ❌ Failed (${failed.length})\n`);
    for (const j of failed) {
      lines.push(statusLine(j));
      if (j.errorMessage) lines.push(`  Error: ${j.errorMessage}`);
    }
    lines.push("");
  }

  if (snapshot.latestFinished && snapshot.latestFinished.status !== "failed") {
    lines.push("## Latest Finished\n");
    const j = snapshot.latestFinished;
    lines.push(statusLine(j));
    if (j.errorMessage) lines.push(`  Error: ${j.errorMessage}`);
    lines.push("");
  }

  const otherRecent = recent.slice(1).filter((j) => j.status !== "failed");
  if (otherRecent.length > 0) {
    lines.push("## Recent Jobs\n");
    for (const j of otherRecent) lines.push(statusLine(j));
    lines.push("");
  }

  if (lines.length === 0) {
    lines.push("No OpenCode jobs found for this workspace.");
  }
  return lines.join("\n");
}
/**
 * Render a job result as human-readable text.
 * @param {object} job
 * @param {object} [resultData]
 * @returns {string}
 */
export function renderResult(job, resultData) {
  const lines = [];
  lines.push(`## Job: ${job.id}\n`);
  lines.push(`- **Type**: ${job.type}`);
  lines.push(`- **Status**: ${job.status}`);
  lines.push(`- **Duration**: ${job.elapsed ?? "unknown"}`);
  if (job.opencodeSessionId) {
    lines.push(`- **OpenCode Session**: ${job.opencodeSessionId}`);
  }
  if (job.recovered || resultData?.recovered) {
    lines.push(`> Recovered from the OpenCode server after the worker exited without returning.`);
  }
  lines.push("");
  if (job.status === "failed") {
    lines.push(`### Error\n\n${job.errorMessage || `Unknown error (job ${job.id})`}`);
  } else if (resultData) {
    const rendered = typeof resultData.rendered === "string" ? resultData.rendered : "";
    if (rendered.trim()) {
      lines.push(`### Output\n\n${rendered}`);
    } else if (Array.isArray(resultData.messages)) {
      // Extract the last assistant message
      const assistantMsgs = resultData.messages.filter((m) => m.role === "assistant");
      const last = assistantMsgs[assistantMsgs.length - 1];
      const text = last ? extractMessageText(last) : "";
      lines.push(text.trim() ? `### Output\n\n${text}` : EMPTY_RESULT_WARNING);
    } else if (typeof resultData.summary === "string" && resultData.summary.trim()) {
      lines.push(`### Summary\n\n${resultData.summary}`);
    } else {
      // "completed" but the model produced nothing usable — NOT a success. Say
      // so loudly so neither a human nor a delegating agent mistakes it.
      lines.push(EMPTY_RESULT_WARNING);
    }
    if (resultData.changedFiles?.length > 0) {
      lines.push(`\n### Changed Files\n`);
      for (const f of resultData.changedFiles) {
        lines.push(`- ${f}`);
      }
    }
    const usageLine = formatUsage(resultData.usage, { requestedModel: resultData.requestedModel });
    if (usageLine) {
      lines.push(`\n### Token Usage\n`);
      lines.push(usageLine);
    }
  } else if (job.result) {
    lines.push(`### Output\n\n${job.result}`);
  }
  return lines.join("\n");
}
/**
 * Format a session usage accumulator into a one-line token/cost summary.
 * Returns "" when there is nothing meaningful to show.
 * @param {object} [usage]
 * @returns {string}
 */
export function formatUsage(usage, opts = {}) {
  if (!usage || typeof usage !== "object") return "";
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total = num(usage.total);
  const input = num(usage.input);
  const output = num(usage.output);
  const reasoning = num(usage.reasoning);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const cost = num(usage.cost);
  const turns = num(usage.turns);
  if (total === 0 && input === 0 && output === 0 && cost === 0) return "";
  const parts = [`**Tokens**: ${total.toLocaleString()} total`];
  const breakdown = [];
  if (input) breakdown.push(`in ${input.toLocaleString()}`);
  if (output) breakdown.push(`out ${output.toLocaleString()}`);
  if (reasoning) breakdown.push(`reasoning ${reasoning.toLocaleString()}`);
  if (cacheRead) breakdown.push(`cache-read ${cacheRead.toLocaleString()}`);
  if (cacheWrite) breakdown.push(`cache-write ${cacheWrite.toLocaleString()}`);
  if (breakdown.length) parts[0] += ` (${breakdown.join(", ")})`;
  if (turns) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  if (cost > 0) parts.push(`~$${cost.toFixed(4)}`);
  const lines = [`- ${parts.join(" · ")}`];
  // Requested-vs-observed model: show what ACTUALLY ran, and warn loudly when it
  // differs from what the caller asked for (a silent default / alias would
  // otherwise be invisible). opts.requestedModel is the ref passed to --model.
  const observed = typeof usage.model === "string" ? usage.model : null;
  const requested = typeof opts.requestedModel === "string" && opts.requestedModel.trim()
    ? opts.requestedModel.trim() : null;
  if (observed) {
    if (requested && requested !== observed) {
      lines.push(`- ⚠️ **Model**: ran \`${observed}\` — NOT the requested \`${requested}\``);
    } else {
      lines.push(`- **Model**: ${observed}${requested ? "" : " (provider default)"}`);
    }
  } else if (requested) {
    lines.push(`- **Model**: ${requested} (requested; server did not report which ran)`);
  }
  return lines.join("\n");
}
/**
 * One-line result trailer for the immediate delegate/result stdout, e.g.
 *   "✓ 1,234 out tok · model:my-model · session:abc123"
 * so the tail is a single line instead of a multi-line block. Correctness
 * signals are preserved: a model mismatch flips the leading mark to ⚠️ and
 * spells out ran-vs-requested. The full multi-line breakdown still lives in
 * formatUsage (shown by `/opencode:result`). Returns "" when nothing is worth
 * showing.
 * @param {object} [usage]
 * @param {{ requestedModel?: string, sessionId?: string }} [opts]
 * @returns {string}
 */
export function formatTrailer(usage, opts = {}) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const u = usage && typeof usage === "object" ? usage : {};
  const out = num(u.output);
  const total = num(u.total);
  const cost = num(u.cost);
  const observed = typeof u.model === "string" && u.model.trim() ? u.model.trim() : null;
  const requested = typeof opts.requestedModel === "string" && opts.requestedModel.trim()
    ? opts.requestedModel.trim() : null;
  const mismatch = !!(observed && requested && observed !== requested);
  const bits = [];
  if (out) bits.push(`${out.toLocaleString()} out tok`);
  else if (total) bits.push(`${total.toLocaleString()} tok`);
  if (cost > 0) bits.push(`~$${cost.toFixed(4)}`);
  if (mismatch) bits.push(`model ran ${observed} (NOT requested ${requested})`);
  else if (observed) bits.push(`model:${observed}`);
  else if (requested) bits.push(`model:${requested} (requested)`);
  const sid = typeof opts.sessionId === "string" && opts.sessionId.trim() ? opts.sessionId.trim() : null;
  if (sid) bits.push(`session:${sid}`);
  if (!bits.length) return "";
  return `${mismatch ? "⚠️" : "✓"} ${bits.join(" · ")}`;
}
/**
 * Render a review result (structured JSON output).
 * @param {object|Array} review
 * @returns {string}
 */
export function renderReview(review) {
  const lines = [];
  
  // Determine the findings list
  let findings;
  if (Array.isArray(review)) {
    findings = review;
  } else if (review && Array.isArray(review.findings)) {
    findings = review.findings;
    if (review.verdict) {
      const emoji = review.verdict === "approve" ? "PASS" : "NEEDS ATTENTION";
      lines.push(`## Review Verdict: ${emoji}\n`);
    }
    if (review.summary) {
      lines.push(`${review.summary}\n`);
    }
  } else {
    lines.push("Could not parse structured review; raw output follows");
    lines.push("```");
    lines.push(JSON.stringify(review, null, 2));
    lines.push("```");
    return lines.join("\n");
  }

  if (findings.length > 0) {
    lines.push(`### Findings (${findings.length})\n`);
    for (const f of findings) {
      if (!f || typeof f !== "object") continue;
      const severity = f.severity ? f.severity.toUpperCase() : "n/a";
      lines.push(`#### ${severity}: ${f.title}`);

      // File and line handling
      const fileParts = [];
      if (f.file) fileParts.push(f.file);
      const lineParts = [];
      if (typeof f.line_start === "number" && Number.isFinite(f.line_start)) lineParts.push(f.line_start);
      if (
        typeof f.line_end === "number" &&
        Number.isFinite(f.line_end) &&
        f.line_end !== f.line_start
      ) {
        lineParts.push(f.line_end);
      }
      if (fileParts.length > 0) {
        const fileLine = lineParts.length > 0 ? `${fileParts[0]}:${lineParts.join("-")}` : fileParts[0];
        lines.push(`- **File**: ${fileLine}`);
      } else {
        lines.push(`- **File**: n/a`);
      }
      
      // Confidence handling
      if (typeof f.confidence === "number" && Number.isFinite(f.confidence)) {
        lines.push(`- **Confidence**: ${(f.confidence * 100).toFixed(0)}%`);
      } else {
        lines.push(`- **Confidence**: n/a`);
      }
      
      if (f.body) lines.push(`- ${f.body}`);
      if (f.recommendation) lines.push(`- **Recommendation**: ${f.recommendation}`);
      lines.push("");
    }
  } else {
    lines.push("No findings.");
  }
  return lines.join("\n");
}
/**
 * Extract text content from a message object.
 * @param {object} msg
 * @returns {string}
 */
function extractMessageText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(msg);
}
/**
 * Render setup status.
 * @param {object} status
 * @returns {string}
 */
export function renderSetup(status) {
  const lines = [];
  lines.push("## OpenCode Setup Status\n");
  lines.push(`- **Installed**: ${status.installed ? "Yes" : "No"}`);
  if (status.version) {
    lines.push(`- **Version**: ${status.version}`);
  }
  if (status.serverRunning !== undefined) {
    lines.push(`- **Server Running**: ${status.serverRunning ? "Yes" : "No"}`);
  }
  if (status.providers?.length > 0) {
    lines.push(`- **Configured Providers**: ${status.providers.join(", ")}`);
  } else if (status.installed) {
    lines.push(`- **Providers**: None configured. Run \`!opencode providers\` to set up.`);
  }
  if (status.reviewGate !== undefined) {
    lines.push(`- **Review Gate**: ${status.reviewGate ? "Enabled" : "Disabled"}`);
  }
  return lines.join("\n");
}
