// tools/call must REJECT unknown argument keys instead of silently dropping
// them. A typo'd key ({bsae: "main"}) used to make oc_review silently review
// the WORKING TREE instead of the intended branch — the same bug class the CC
// CLI fixed with strict review parsing in 2.3.6.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allowedToolArgKeys, unknownToolArgKeys } from "../plugins/opencode-companion/scripts/oc-companion.mjs";

describe("tool argument key validation", () => {
  it("flags a typo'd oc_review key (bsae) as unknown", () => {
    assert.deepEqual(unknownToolArgKeys("oc_review", { bsae: "main" }), ["bsae"]);
  });

  it("accepts every declared key for oc_review", () => {
    const allowed = allowedToolArgKeys("oc_review");
    assert.ok(allowed.has("base"), "oc_review must declare base");
    const args = {};
    for (const k of allowed) args[k] = "x";
    assert.deepEqual(unknownToolArgKeys("oc_review", args), []);
  });

  it("validates every declared tool the same way", () => {
    for (const tool of ["oc_delegate", "oc_delegate_batch", "oc_adversarial_review", "oc_status", "oc_result", "oc_cancel"]) {
      const allowed = allowedToolArgKeys(tool);
      assert.ok(allowed.size > 0, `${tool} must declare its argument keys`);
      assert.deepEqual(unknownToolArgKeys(tool, {}), [], `${tool}: empty args are always valid`);
      assert.deepEqual(unknownToolArgKeys(tool, { totallyBogusKey: 1 }), ["totallyBogusKey"]);
    }
  });
});
