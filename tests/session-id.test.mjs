// getClaudeSessionId reads the session id from the environment. The override
// OPENCODE_COMPANION_SESSION_ID must win; the real fallback is Claude Code's
// CLAUDE_CODE_SESSION_ID (the old code read the non-existent CLAUDE_SESSION_ID,
// which silently disabled per-session job isolation).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getClaudeSessionId } from "../plugins/opencode-companion/scripts/lib/tracked-jobs.mjs";

const OVERRIDE = "OPENCODE_COMPANION_SESSION_ID";
const REAL = "CLAUDE_CODE_SESSION_ID";
const LEGACY = "CLAUDE_SESSION_ID"; // the wrong var the code used to read

function withEnv(vals, fn) {
  const keys = [OVERRIDE, REAL, LEGACY];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    for (const [k, v] of Object.entries(vals)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("getClaudeSessionId — env priority", () => {
  it("prefers OPENCODE_COMPANION_SESSION_ID over CLAUDE_CODE_SESSION_ID", () => {
    withEnv({ [OVERRIDE]: "override-id", [REAL]: "cc-id" }, () => {
      assert.equal(getClaudeSessionId(), "override-id");
    });
  });

  it("falls back to CLAUDE_CODE_SESSION_ID when the override is absent", () => {
    withEnv({ [REAL]: "cc-id" }, () => {
      assert.equal(getClaudeSessionId(), "cc-id");
    });
  });

  it("ignores the non-existent CLAUDE_SESSION_ID", () => {
    withEnv({ [LEGACY]: "legacy-id" }, () => {
      assert.equal(getClaudeSessionId(), undefined);
    });
  });

  it("returns undefined when nothing is set", () => {
    withEnv({}, () => {
      assert.equal(getClaudeSessionId(), undefined);
    });
  });
});
