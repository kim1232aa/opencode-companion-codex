import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatUsage, renderResult } from "../plugins/opencode-companion/scripts/lib/render.mjs";

describe("formatUsage", () => {
  it("returns empty string for missing/empty usage", () => {
    assert.equal(formatUsage(undefined), "");
    assert.equal(formatUsage(null), "");
    assert.equal(formatUsage({}), "");
    assert.equal(formatUsage({ total: 0, input: 0, output: 0, cost: 0 }), "");
  });

  it("formats total plus a breakdown of the non-zero components", () => {
    const out = formatUsage({
      total: 12873,
      input: 4665,
      output: 2,
      reasoning: 14,
      cacheRead: 8192,
      cacheWrite: 0,
      cost: 0.0123,
      turns: 3,
    });
    assert.match(out, /12,873 total/);
    assert.match(out, /in 4,665/);
    assert.match(out, /out 2/);
    assert.match(out, /reasoning 14/);
    assert.match(out, /cache-read 8,192/);
    assert.ok(!out.includes("cache-write"), out); // zero component omitted
    assert.match(out, /3 turns/);
    assert.match(out, /\$0\.0123/);
  });

  it("singularizes a single turn and omits zero cost", () => {
    const out = formatUsage({ total: 100, input: 100, turns: 1, cost: 0 });
    assert.match(out, /1 turn\b/);
    assert.ok(!out.includes("$"), out);
  });

  it("ignores non-finite numbers instead of printing NaN", () => {
    const out = formatUsage({ total: NaN, input: 50, output: 50 });
    assert.ok(!/NaN/.test(out), out);
    assert.match(out, /0 total/); // NaN total coerces to 0; the breakdown still renders
    assert.match(out, /in 50, out 50/);
  });

  it("renderResult surfaces a Token Usage section when usage is present", () => {
    const job = { id: "task-1", type: "task", status: "completed", elapsed: "3s" };
    const out = renderResult(job, { rendered: "done", usage: { total: 500, input: 500, turns: 1 } });
    assert.match(out, /### Token Usage/);
    assert.match(out, /500 total/);
  });

  it("renderResult omits the Token Usage section when usage is absent/empty", () => {
    const job = { id: "task-2", type: "task", status: "completed", elapsed: "3s" };
    const out = renderResult(job, { rendered: "done" });
    assert.ok(!out.includes("Token Usage"), out);
  });
});
