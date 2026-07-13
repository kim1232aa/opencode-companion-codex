import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderReview, renderResult } from "../plugins/opencode-companion/scripts/lib/render.mjs";

describe("renderReview — malformed model output guards", () => {
  it("never emits 'NaN%' when confidence is missing or non-numeric", () => {
    const out = renderReview({ findings: [{ title: "x", severity: "high", confidence: "very" }] });
    assert.ok(!out.includes("NaN%"), out);
  });

  it("never emits the literal 'undefined' for missing severity/file/lines", () => {
    const out = renderReview({ findings: [{ title: "x" }] });
    assert.ok(!/undefined/.test(out), out);
  });

  it("treats a top-level array as the findings list (not 'No findings')", () => {
    const out = renderReview([{ title: "leak", severity: "high", body: "b", recommendation: "r" }]);
    assert.ok(/leak/i.test(out));
    assert.ok(!/No findings/i.test(out));
  });

  it("surfaces raw output for a wrong-shape object instead of dropping it", () => {
    const out = renderReview({ issues: [{ title: "wrong-key" }] });
    assert.ok(/could not parse|raw output/i.test(out), out);
  });
});

describe("renderResult", () => {
  it("includes the job id when a failed job has no errorMessage", () => {
    const out = renderResult({ id: "task-abc", type: "task", status: "failed" }, null);
    assert.ok(out.includes("task-abc"), out);
  });
});
