import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suggestModelRefs } from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";

const refs = new Set([
  "volcano-coding/火山方舟Coding_Plan/glm-5.2",
  "volcano-coding/商汤/glm-5.2",
  "volcano-coding/zai/glm-5.2",
  "volcano-coding/火山方舟Agent_Plan/kimi-k2.7-code",
  "openai/gpt-5",
]);

describe("suggestModelRefs", () => {
  it("recovers the full ref when the provider prefix was dropped", () => {
    const s = suggestModelRefs(refs, "商汤/glm-5.2");
    assert.equal(s[0], "volcano-coding/商汤/glm-5.2");
  });
  it("returns the exact ref alone when already valid", () => {
    const s = suggestModelRefs(refs, "openai/gpt-5");
    assert.deepEqual(s, ["openai/gpt-5"]);
  });
  it("suggests same-model-id across groups when only the model name is given", () => {
    const s = suggestModelRefs(refs, "glm-5.2");
    assert.ok(s.every((r) => r.endsWith("/glm-5.2")));
    assert.ok(s.length >= 2);
  });
  it("returns [] for empty input", () => {
    assert.deepEqual(suggestModelRefs(refs, ""), []);
  });
});
