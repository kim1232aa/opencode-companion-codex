// Isolate all state writes from the real ~/.opencode-companion-codex store.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.OPENCODE_COMPANION_DATA = __mkdtemp(__join(__tmpdir(), "oc-test-data-"));

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recoverStrandedResults, pidStartTime } from "../plugins/opencode-companion/scripts/lib/job-control.mjs";
import { upsertJob, loadState } from "../plugins/opencode-companion/scripts/lib/state.mjs";

// An address that refuses fast, to stand in for "server unreachable".
const DEAD_URL = "http://127.0.0.1:1";

describe("recoverStrandedResults", () => {
  it("returns the jobs untouched when nothing is a stranded candidate", async () => {
    const jobs = [
      { id: "a", status: "completed", opencodeSessionId: "s1" }, // terminal
      { id: "b", status: "running" }, // no session id
      {
        id: "c",
        status: "running",
        opencodeSessionId: "s2",
        pid: process.pid, // live worker (this process)
        pidStart: pidStartTime(process.pid),
      },
    ];
    const out = await recoverStrandedResults(os.tmpdir(), jobs, DEAD_URL);
    assert.equal(out, jobs, "no candidates ⇒ same array, no server I/O");
  });

  it("keeps a job alive (awaitingServer) instead of completing/failing it when the server is unreachable", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
    try {
      // Seed via the store (like every real caller): the unhealthy branch
      // merges via upsertJob and reloads state.
      upsertJob(ws, {
        id: "x",
        status: "running",
        opencodeSessionId: "sess-dead",
        pid: 999999999, // dead pid
        pidStart: "1", // fingerprint that can't match ⇒ provably gone
      });
      const out = await recoverStrandedResults(ws, loadState(ws).jobs, DEAD_URL);
      const j = out.find((k) => k.id === "x");
      assert.equal(j.status, "running", "unreachable server must not fake-complete or fail the job");
      assert.equal(j.awaitingServer, true, "kept alive so a finished answer can still be recovered when the server returns");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
