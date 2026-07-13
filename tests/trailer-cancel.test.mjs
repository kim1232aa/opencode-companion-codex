// Phase-4 frontend behaviors ported into the Codex MCP server (oc-companion.mjs):
//   1. #12 — the concise one-line result trailer (buildResultTrailer): tokens,
//      model, job id and session id folded into a single line instead of the
//      old multi-line block the user called "十分冗长". VERBOSE_TRAILER=1 restores
//      the multi-line formatUsage breakdown.
//   2. #12 — oc_cancel cancel-all: with no job ref, cancel EVERY running/pending
//      job in the current Claude session, strictly session-scoped so another
//      session's jobs (or terminal jobs) are never touched. A ref still targets
//      exactly one job.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate ALL state writes from the real store, and point at a dead port so a
// stray abortSession can never reach a live OpenCode server. Both must be set
// before importing the modules that read them.
process.env.OPENCODE_COMPANION_DATA = mkdtempSync(join(tmpdir(), "oc-trailer-cancel-"));
process.env.OPENCODE_SERVER_PORT = "1";

const { buildResultTrailer, handleCancel } = await import(
  "../plugins/opencode-companion/scripts/oc-companion.mjs"
);
const { upsertJob, loadState } = await import(
  "../plugins/opencode-companion/scripts/lib/state.mjs"
);

function ws() {
  return mkdtempSync(join(tmpdir(), "oc-cancel-ws-"));
}

// ── #12 concise trailer ─────────────────────────────────────────────────────

describe("buildResultTrailer — concise one-line trailer (#12)", () => {
  const VERBOSE = "OPENCODE_COMPANION_VERBOSE_TRAILER";
  let saved;
  beforeEach(() => { saved = process.env[VERBOSE]; delete process.env[VERBOSE]; });
  afterEach(() => { if (saved === undefined) delete process.env[VERBOSE]; else process.env[VERBOSE] = saved; });

  it("folds tokens, model, job and session into a single ✓ line", () => {
    const t = buildResultTrailer(
      { output: 1234, model: "glm-5.2" },
      { requestedModel: "glm-5.2", sessionId: "ses_abc", jobId: "oc_job1" }
    );
    assert.equal(t, "\n✓ 1,234 out tok · model:glm-5.2 · job:oc_job1 · session:ses_abc");
    // A single content line (only the leading newline separator besides it).
    assert.equal(t.trim().split("\n").length, 1);
  });

  it("surfaces a model mismatch with ⚠️ instead of ✓", () => {
    const t = buildResultTrailer(
      { output: 10, model: "actually-ran" },
      { requestedModel: "asked-for", sessionId: "s", jobId: "j" }
    );
    assert.match(t, /^\n⚠️ /);
    assert.match(t, /actually-ran/);
    assert.match(t, /NOT requested asked-for/);
    assert.doesNotMatch(t, /✓/);
    // job + session still ride along on the same line.
    assert.match(t, /job:j · session:s$/);
  });

  it("still carries job + session when usage is empty (fallback line)", () => {
    const t = buildResultTrailer(null, { sessionId: "ses_x", jobId: "oc_y" });
    assert.equal(t, "\n✓ job:oc_y · session:ses_x");
  });

  it("returns an empty string when there is nothing at all to show", () => {
    assert.equal(buildResultTrailer(null, {}), "");
    assert.equal(buildResultTrailer(undefined, undefined), "");
  });

  it("VERBOSE_TRAILER=1 falls back to the multi-line formatUsage breakdown", () => {
    process.env[VERBOSE] = "1";
    const t = buildResultTrailer(
      { total: 5000, input: 3000, output: 2000, model: "glm-5.2" },
      { requestedModel: "glm-5.2", sessionId: "ses_abc", jobId: "oc_job1" }
    );
    assert.match(t, /---/);
    assert.match(t, /\*\*Tokens\*\*/);                 // multi-line formatUsage marker
    assert.ok(t.split("\n").length > 2, "verbose trailer spans multiple lines");
    // Ids are preserved on their own bracketed line so nothing is lost.
    assert.match(t, /\[job:oc_job1 · session:ses_abc\]/);
  });
});

// ── #12 oc_cancel cancel-all ────────────────────────────────────────────────

describe("oc_cancel — cancel-all (#12)", () => {
  const SID = "OPENCODE_COMPANION_SESSION_ID";
  let savedSid;
  beforeEach(() => { savedSid = process.env[SID]; process.env[SID] = "S1"; });
  afterEach(() => { if (savedSid === undefined) delete process.env[SID]; else process.env[SID] = savedSid; });

  it("no ref cancels every running/pending job in THIS session only", async () => {
    const w = ws();
    upsertJob(w, { id: "run1", type: "task", status: "running", sessionId: "S1" });
    upsertJob(w, { id: "pend1", type: "task", status: "pending", sessionId: "S1" });
    upsertJob(w, { id: "done1", type: "task", status: "completed", sessionId: "S1" });
    upsertJob(w, { id: "other", type: "task", status: "running", sessionId: "S2" });

    const res = await handleCancel({ workspace: w });
    const out = res.content[0].text;
    assert.equal(res.isError, undefined);
    assert.match(out, /Canceled 2 jobs:/);
    assert.match(out, /run1/);
    assert.match(out, /pend1/);

    const jobs = loadState(w).jobs;
    assert.equal(jobs.find((j) => j.id === "run1").status, "canceled");
    assert.equal(jobs.find((j) => j.id === "pend1").status, "canceled");
    // Terminal job in this session is left exactly as it was.
    assert.equal(jobs.find((j) => j.id === "done1").status, "completed");
    // Another session's running job is NEVER touched.
    assert.equal(jobs.find((j) => j.id === "other").status, "running");
  });

  it("a ref cancels exactly that one job (single-job path preserved)", async () => {
    const w = ws();
    upsertJob(w, { id: "aaa111", type: "task", status: "running", sessionId: "S1" });
    upsertJob(w, { id: "bbb222", type: "task", status: "running", sessionId: "S1" });

    const res = await handleCancel({ workspace: w, job: "aaa111" });
    assert.match(res.content[0].text, /Canceled 1 job: aaa111/);
    const jobs = loadState(w).jobs;
    assert.equal(jobs.find((j) => j.id === "aaa111").status, "canceled");
    assert.equal(jobs.find((j) => j.id === "bbb222").status, "running");
  });

  it("an ambiguous prefix is rejected without canceling anything", async () => {
    const w = ws();
    upsertJob(w, { id: "dup-1", type: "task", status: "running", sessionId: "S1" });
    upsertJob(w, { id: "dup-2", type: "task", status: "running", sessionId: "S1" });

    const res = await handleCancel({ workspace: w, job: "dup" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /multiple running jobs/);
    const jobs = loadState(w).jobs;
    assert.equal(jobs.find((j) => j.id === "dup-1").status, "running");
    assert.equal(jobs.find((j) => j.id === "dup-2").status, "running");
  });

  it("reports nothing to cancel when the session has no active jobs", async () => {
    const w = ws();
    upsertJob(w, { id: "gone", type: "task", status: "completed", sessionId: "S1" });
    upsertJob(w, { id: "elsewhere", type: "task", status: "running", sessionId: "S2" });

    const res = await handleCancel({ workspace: w });
    assert.match(res.content[0].text, /No active job to cancel/);
    // S2's running job stays running — cancel-all is strictly session-scoped.
    assert.equal(loadState(w).jobs.find((j) => j.id === "elsewhere").status, "running");
  });
});
