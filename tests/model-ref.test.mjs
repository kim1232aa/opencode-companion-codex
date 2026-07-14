import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseModelRef } from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";

describe("parseModelRef", () => {
  it("splits provider/model on the first slash", () => {
    assert.deepEqual(parseModelRef("openai/gpt-4"), { providerID: "openai", modelID: "gpt-4" });
  });

  it("keeps later slashes in the model id (custom combo ids)", () => {
    assert.deepEqual(
      parseModelRef("myprovider/group/model-name"),
      { providerID: "myprovider", modelID: "group/model-name" }
    );
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(parseModelRef("  anthropic/claude  "), { providerID: "anthropic", modelID: "claude" });
  });

  it("rejects a bare model with no provider", () => {
    assert.throws(() => parseModelRef("gpt-4"), /provider\/model/);
  });

  it("rejects empty provider or model segments", () => {
    assert.throws(() => parseModelRef("/foo"), /provider\/model/);
    assert.throws(() => parseModelRef("openai/"), /provider\/model/);
  });
});
