import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withFileLock } from "../plugins/opencode-companion/scripts/lib/fs.mjs";

function tmpLock() {
  return path.join(os.tmpdir(), `oclock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ".lock");
}

describe("withFileLock", () => {
  it("runs fn and releases the lock (dir gone afterwards)", () => {
    const lock = tmpLock();
    const out = withFileLock(lock, () => 42);
    assert.equal(out, 42);
    assert.equal(fs.existsSync(lock), false, "lock dir should be removed on release");
  });

  it("serializes nested-like sequential critical sections without leaking", () => {
    const lock = tmpLock();
    let counter = 0;
    for (let i = 0; i < 5; i++) {
      withFileLock(lock, () => { counter += 1; });
      assert.equal(fs.existsSync(lock), false);
    }
    assert.equal(counter, 5);
  });

  it("does NOT steal a lock held by a live process (no double-run)", () => {
    const lock = tmpLock();
    // Simulate a live holder: create the lock dir with THIS process's pid as owner.
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), `${process.pid}:live`, "utf8");
    // A waiter should time out (can't acquire) rather than steal it, because the
    // owner pid is alive and the lock is fresh (well under the 60s fallback).
    assert.throws(() => withFileLock(lock, () => { throw new Error("must not run"); }), /Timed out waiting for lock/);
    // cleanup
    fs.rmSync(lock, { recursive: true, force: true });
  });

  it("reclaims a lock whose owner pid is dead", () => {
    const lock = tmpLock();
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), `999999999:dead`, "utf8"); // dead pid
    let ran = false;
    withFileLock(lock, () => { ran = true; });
    assert.equal(ran, true, "should reclaim a dead owner's lock and run");
    assert.equal(fs.existsSync(lock), false);
  });

  it("release does not delete a lock that was reclaimed by someone else (ABA-safe)", () => {
    const lock = tmpLock();
    // Acquire, then simulate a foreign holder replacing our lock mid-fn:
    withFileLock(lock, () => {
      // overwrite the owner file with a different token to mimic a steal
      fs.writeFileSync(path.join(lock, "owner"), `${process.pid}:someone-else`, "utf8");
    });
    // Our release must have seen the token no longer matches and left it alone.
    assert.equal(fs.existsSync(lock), true, "must not delete a lock we no longer own");
    fs.rmSync(lock, { recursive: true, force: true });
  });
});
