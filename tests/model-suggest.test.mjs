import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suggestModelRefs } from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";

// Multi-slash model ids under one provider — a "combo router" shape where the
// modelID itself carries a group prefix, so a full ref has several slashes.
const refs = new Set([
  "myprovider/group-a/model-x",
  "myprovider/group-b/model-x",
  "myprovider/group-c/model-x",
  "myprovider/group-d/other-model",
  "openai/gpt-5",
]);

describe("suggestModelRefs", () => {
  it("recovers the full ref when the provider prefix was dropped", () => {
    const s = suggestModelRefs(refs, "group-b/model-x");
    assert.equal(s[0], "myprovider/group-b/model-x");
  });
  it("returns the exact ref alone when already valid", () => {
    const s = suggestModelRefs(refs, "openai/gpt-5");
    assert.deepEqual(s, ["openai/gpt-5"]);
  });
  it("suggests same-model-id across groups when only the model name is given", () => {
    const s = suggestModelRefs(refs, "model-x");
    assert.ok(s.every((r) => r.endsWith("/model-x")));
    assert.ok(s.length >= 2);
  });
  it("returns [] for empty input", () => {
    assert.deepEqual(suggestModelRefs(refs, ""), []);
  });
});
