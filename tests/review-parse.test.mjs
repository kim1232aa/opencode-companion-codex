// Unit tests for the review sub-system's pure helpers, imported directly from
// the frontend (the entry guard keeps importing from spawning the server):
//   - tryParseJson: recover a structured review payload from model text
//   - pickResumeCandidate: choose the newest resumable OpenCode task session
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tryParseJson, pickResumeCandidate } from "../plugins/opencode-companion/scripts/oc-companion.mjs";

describe("tryParseJson", () => {
  it("parses a ```json-tagged fenced block, ignoring surrounding prose", () => {
    const text = 'Here is my review:\n```json\n{"verdict":"approve","findings":[]}\n```\nDone.';
    assert.deepEqual(tryParseJson(text), { verdict: "approve", findings: [] });
  });

  it("prefers the json-tagged fence over a plain fence", () => {
    const text = "```\n{\"which\":\"plain\"}\n```\nand\n```json\n{\"which\":\"tagged\"}\n```";
    assert.deepEqual(tryParseJson(text), { which: "tagged" });
  });

  it("recovers a bare object embedded in prose", () => {
    const text = 'The result is {"verdict":"needs-attention","findings":[{"file":"a.js"}]} overall.';
    assert.deepEqual(tryParseJson(text), {
      verdict: "needs-attention",
      findings: [{ file: "a.js" }],
    });
  });

  it("parses a whole-string JSON payload with no fences", () => {
    assert.deepEqual(tryParseJson('{"summary":"ok"}'), { summary: "ok" });
  });

  it("returns null for non-JSON text and non-strings", () => {
    assert.equal(tryParseJson("no structured output here at all"), null);
    assert.equal(tryParseJson(null), null);
    assert.equal(tryParseJson(42), null);
  });
});

describe("pickResumeCandidate", () => {
  const jobs = [
    { id: "task_old", type: "task", status: "completed", opencodeSessionId: "sess_old", updatedAt: "2026-07-14T01:00:00Z" },
    { id: "task_new", type: "task", status: "completed", opencodeSessionId: "sess_new", updatedAt: "2026-07-14T03:00:00Z" },
    { id: "review_x", type: "review", status: "completed", opencodeSessionId: "sess_rev", updatedAt: "2026-07-14T05:00:00Z" },
    { id: "task_nosess", type: "task", status: "completed", updatedAt: "2026-07-14T09:00:00Z" },
    { id: "task_failed", type: "task", status: "failed", opencodeSessionId: "sess_fail", updatedAt: "2026-07-14T08:00:00Z" },
  ];

  it("returns the newest completed/running task job that has a session id", () => {
    const c = pickResumeCandidate(jobs, undefined);
    assert.deepEqual(c, { available: true, jobId: "task_new", opencodeSessionId: "sess_new" });
  });

  it("ignores review jobs, sessionless jobs, and failed jobs", () => {
    // The only candidates are task_old and task_new; the newest wins. A review
    // job (later timestamp) and a failed task (later timestamp) must not win.
    const c = pickResumeCandidate(jobs, undefined);
    assert.notEqual(c.jobId, "review_x");
    assert.notEqual(c.jobId, "task_failed");
    assert.notEqual(c.jobId, "task_nosess");
  });

  it("counts a running task with a session id as resumable", () => {
    const running = [
      { id: "task_run", type: "task", status: "running", opencodeSessionId: "sess_run", updatedAt: "2026-07-14T10:00:00Z" },
    ];
    assert.deepEqual(pickResumeCandidate(running, undefined), {
      available: true, jobId: "task_run", opencodeSessionId: "sess_run",
    });
  });

  it("restricts to the owning session id when one is supplied", () => {
    const owned = [
      { id: "task_mine", type: "task", status: "completed", opencodeSessionId: "sess_mine", sessionId: "S1", updatedAt: "2026-07-14T02:00:00Z" },
      { id: "task_theirs", type: "task", status: "completed", opencodeSessionId: "sess_theirs", sessionId: "S2", updatedAt: "2026-07-14T09:00:00Z" },
    ];
    const c = pickResumeCandidate(owned, "S1");
    assert.deepEqual(c, { available: true, jobId: "task_mine", opencodeSessionId: "sess_mine" });
  });

  it("reports unavailable for an empty or nullish job list", () => {
    assert.deepEqual(pickResumeCandidate([], undefined), { available: false, jobId: null, opencodeSessionId: null });
    assert.deepEqual(pickResumeCandidate(undefined, undefined), { available: false, jobId: null, opencodeSessionId: null });
  });
});
