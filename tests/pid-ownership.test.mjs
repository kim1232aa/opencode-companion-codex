import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pidStartTime, isOwnedProcessAlive } from "../plugins/opencode-companion/scripts/lib/job-control.mjs";

const HAS_PROC = process.platform === "linux";

describe("pidStartTime", () => {
  it("reads a stable start-time for our own live pid (Linux)", { skip: !HAS_PROC }, () => {
    const a = pidStartTime(process.pid);
    const b = pidStartTime(process.pid);
    assert.ok(a, "expected a start-time for the current process");
    assert.match(a, /^\d+$/);
    assert.equal(a, b, "start-time must be stable across reads");
  });

  it("returns null for invalid pids", () => {
    assert.equal(pidStartTime(0), null);
    assert.equal(pidStartTime(-1), null);
    assert.equal(pidStartTime(undefined), null);
    assert.equal(pidStartTime(1.5), null);
  });

  it("returns null for a pid that does not exist", { skip: !HAS_PROC }, () => {
    // 2^22-ish: above default pid_max, so no such process.
    assert.equal(pidStartTime(4194303), null);
  });
});

describe("isOwnedProcessAlive", () => {
  it("is true for our own pid with the matching fingerprint", { skip: !HAS_PROC }, () => {
    const start = pidStartTime(process.pid);
    assert.equal(isOwnedProcessAlive(process.pid, start), true);
  });

  it("is false when the fingerprint does NOT match (pid recycled)", { skip: !HAS_PROC }, () => {
    // Our pid is alive but the recorded start-time belongs to a different (dead)
    // process — treat as not-ours so we never signal it.
    assert.equal(isOwnedProcessAlive(process.pid, "1"), false);
  });

  it("falls back to bare liveness when no fingerprint is recorded", () => {
    assert.equal(isOwnedProcessAlive(process.pid, undefined), true);
    assert.equal(isOwnedProcessAlive(process.pid, null), true);
  });

  it("is false for a dead pid regardless of fingerprint", () => {
    assert.equal(isOwnedProcessAlive(4194303, "123"), false);
    assert.equal(isOwnedProcessAlive(0, undefined), false);
  });
});
