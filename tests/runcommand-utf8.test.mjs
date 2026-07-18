// runCommand must not corrupt multibyte UTF-8 across stream chunk boundaries.
//
// Regression: output was accumulated with `str += chunk`, coercing each Buffer
// chunk to a string INDEPENDENTLY — a CJK/emoji char split across a ~64KiB pipe
// read decoded to U+FFFD pairs. The worktree writeback then fed that corrupted
// patch to `git apply`, which applied it with exit 0: silent data corruption
// reported as success. Chunks are now concatenated as Buffers and decoded once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runCommand } from "../plugins/opencode-companion/scripts/lib/process.mjs";

describe("runCommand — multibyte output integrity", () => {
  it("300KB of pure CJK survives chunk boundaries with zero U+FFFD", async () => {
    const n = 100000; // 100k chars × 3 bytes = 300KB, dozens of chunk splits
    const r = await runCommand("node", ["-e", `process.stdout.write("汉".repeat(${n}))`]);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.length, n, "length must be exact — replacement chars inflate it");
    assert.equal((r.stdout.match(/�/g) || []).length, 0, "no replacement characters");
  });

  it("stderr gets the same treatment", async () => {
    const n = 100000;
    const r = await runCommand("node", ["-e", `process.stderr.write("界".repeat(${n}))`]);
    assert.equal(r.stderr.length, n);
    assert.equal((r.stderr.match(/�/g) || []).length, 0);
  });

  it("byte-based overflow budget still trips (honest error path preserved)", async () => {
    const r = await runCommand("node", ["-e", `process.stdout.write("汉".repeat(100000))`], {
      maxOutputBytes: 1024,
    });
    assert.equal(r.overflowed, true);
    // The kept prefix respects the BYTE budget (not a char count).
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 1024 + 3, `kept ${Buffer.byteLength(r.stdout, "utf8")} bytes`);
  });
});
