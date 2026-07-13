import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderStatus, renderResult, isEmptyResult } from "../plugins/opencode-companion/scripts/lib/render.mjs";

describe("renderStatus — multi-agent dashboard", () => {
  it("shows live token count + staleness for a running job, and flags stuck", () => {
    const fresh = `[${new Date().toISOString()}] heartbeat: 143,206 tokens so far (9 turns)`;
    const stale = `[${new Date(Date.now() - 300000).toISOString()}] heartbeat: 50,000 tokens so far (3 turns)`;
    const out = renderStatus({
      running: [
        { id: "task-a", type: "task", status: "running", phase: "investigating", elapsed: "1m", progressPreview: fresh },
        { id: "task-b", type: "task", status: "running", phase: "investigating", elapsed: "5m", progressPreview: stale },
      ],
      recent: [], latestFinished: null,
    });
    assert.match(out, /143,206 tokens/);
    assert.match(out, /updated \d+s ago/);
    assert.match(out, /possibly stuck/); // the 5-min-stale one
    assert.match(out, /Running Jobs \(2\)/);
  });

  it("surfaces a failed job up front with its error", () => {
    const out = renderStatus({
      running: [],
      recent: [
        { id: "task-ok", type: "task", status: "completed", elapsed: "3s" },
        { id: "task-bad", type: "task", status: "failed", elapsed: "2s", errorMessage: "boom" },
      ],
      latestFinished: { id: "task-ok", type: "task", status: "completed", elapsed: "3s" },
    });
    assert.match(out, /❌ Failed \(1\)/);
    assert.match(out, /Error: boom/);
  });

  it("badges a completed-but-empty job", () => {
    const out = renderStatus({
      running: [],
      recent: [{ id: "task-e", type: "task", status: "completed", emptyResult: true, elapsed: "4s" }],
      latestFinished: { id: "task-e", type: "task", status: "completed", emptyResult: true, elapsed: "4s" },
    });
    assert.match(out, /⚠️ no output/);
  });
});

describe("empty-result detection", () => {
  it("isEmptyResult true for blank rendered", () => {
    assert.equal(isEmptyResult({ rendered: "   " }), true);
    assert.equal(isEmptyResult({}), true);
    assert.equal(isEmptyResult(null), true);
  });
  it("isEmptyResult false when there is text", () => {
    assert.equal(isEmptyResult({ rendered: "hello" }), false);
    assert.equal(isEmptyResult({ summary: "s" }), false);
  });
  it("renderResult warns loudly on an empty completed job", () => {
    const out = renderResult({ id: "j", type: "task", status: "completed", elapsed: "1s" }, { rendered: "  " });
    assert.match(out, /⚠️ No output/);
    assert.match(out, /NOT a successful result/);
  });
});
