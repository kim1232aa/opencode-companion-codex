// Isolate all state writes from the real ~/.opencode-companion-codex store.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.OPENCODE_COMPANION_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-data-"));

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reconcileStrandedJobs,
  resolveResultJob,
  resolveCancelableJob,
  buildStatusSnapshot,
} from "../plugins/opencode-companion/scripts/lib/job-control.mjs";
import { upsertJob, loadState } from "../plugins/opencode-companion/scripts/lib/state.mjs";

function ws() {
  return `/tmp/ochealtest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("reconcileStrandedJobs", () => {
  it("marks a dead-pid non-terminal job failed, leaves a live one running", () => {
    const w = ws();
    upsertJob(w, { id: "task-dead", type: "task", status: "running", pid: 999999999 });
    upsertJob(w, { id: "task-live", type: "task", status: "running", pid: process.pid });
    const out = reconcileStrandedJobs(w, loadState(w).jobs);
    assert.equal(out.find((j) => j.id === "task-dead").status, "failed");
    assert.equal(out.find((j) => j.id === "task-live").status, "running");
  });

  it("leaves terminal jobs untouched", () => {
    const w = ws();
    upsertJob(w, { id: "task-done", type: "task", status: "completed", pid: 999999999 });
    const out = reconcileStrandedJobs(w, loadState(w).jobs);
    assert.equal(out.find((j) => j.id === "task-done").status, "completed");
  });

  it("keeps a recently-flagged awaitingServer job running despite a dead pid", () => {
    const w = ws();
    // Worker gone but recoverStrandedResults saw the session still generating.
    upsertJob(w, { id: "task-await", type: "task", status: "running", pid: 999999999, awaitingServer: true });
    const out = reconcileStrandedJobs(w, loadState(w).jobs);
    assert.equal(out.find((j) => j.id === "task-await").status, "running");
  });

  it("fails an awaitingServer job once it exceeds the wait bound", () => {
    const w = ws();
    upsertJob(w, { id: "task-await-old", type: "task", status: "running", pid: 999999999, awaitingServer: true });
    // Backdate createdAt past the 45-minute bound (a wedged server can't hold it forever).
    upsertJob(w, { id: "task-await-old", createdAt: new Date(Date.now() - 60 * 60000).toISOString() });
    const out = reconcileStrandedJobs(w, loadState(w).jobs);
    assert.equal(out.find((j) => j.id === "task-await-old").status, "failed");
  });
});

describe("resolveResultJob / resolveCancelableJob session scoping", () => {
  const jobs = [
    { id: "a", status: "completed", sessionId: "S1", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "b", status: "completed", sessionId: "S2", updatedAt: "2026-01-02T00:00:00Z" }, // newest
    { id: "c", status: "running", sessionId: "S1" },
    { id: "d", status: "running", sessionId: "S2" },
  ];

  it("result without ref scopes to the session when given one", () => {
    assert.equal(resolveResultJob(jobs, undefined, { sessionId: "S1" }).job.id, "a");
    // no session ⇒ globally newest finished
    assert.equal(resolveResultJob(jobs, undefined).job.id, "b");
  });

  it("cancel without ref scopes to the session", () => {
    assert.equal(resolveCancelableJob(jobs, undefined, { sessionId: "S1" }).job.id, "c");
  });

  it("canceled status counts as a resolvable result", () => {
    const j = [{ id: "x", status: "canceled", sessionId: "S1", updatedAt: "2026-01-03T00:00:00Z" }];
    assert.equal(resolveResultJob(j, "x").job.id, "x");
  });
});

describe("buildStatusSnapshot", () => {
  it("treats pending+running as running, and completed/failed/canceled as finished", () => {
    const jobs = [
      { id: "p", status: "pending", sessionId: "S" },
      { id: "r", status: "running", sessionId: "S" },
      { id: "c", status: "completed", sessionId: "S", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "x", status: "canceled", sessionId: "S", updatedAt: "2026-01-02T00:00:00Z" },
    ];
    const snap = buildStatusSnapshot(jobs, "/tmp/x", { sessionId: "S" });
    assert.equal(snap.running.length, 2);
    assert.ok(snap.recent.some((j) => j.id === "x"));
    assert.ok(!snap.running.some((j) => j.status === "pending" && j.id === "c"));
  });
});
