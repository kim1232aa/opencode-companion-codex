// A cancel that lands while runTrackedJob is executing must survive BOTH
// finalize paths: the success path (an aborted OpenCode session returns
// normally with partial output) and the error path (sendPrompt throws).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OPENCODE_COMPANION_DATA = mkdtempSync(join(tmpdir(), "oc-cas-"));

const { runTrackedJob, createJobRecord } = await import("../plugins/opencode-companion/scripts/lib/tracked-jobs.mjs");
const { upsertJob, loadState, jobDataPath } = await import("../plugins/opencode-companion/scripts/lib/state.mjs");

const ws = mkdtempSync(join(tmpdir(), "oc-cas-ws-"));

describe("runTrackedJob — terminal status is never clobbered", () => {
  it("success path does not flip canceled → completed", async () => {
    const job = createJobRecord(ws, "task", {});
    await runTrackedJob(ws, job, async () => {
      // Simulate a cancel landing mid-run (CAS wrote canceled), after which an
      // aborted session RETURNS normally with partial output.
      upsertJob(ws, { id: job.id, status: "canceled", errorMessage: "Canceled by user" });
      return { rendered: "partial output", summary: "partial" };
    });
    const j = loadState(ws).jobs.find((x) => x.id === job.id);
    assert.equal(j.status, "canceled");
    // And the partial answer must NOT be left on disk — result/oc_result would
    // otherwise surface it, contradicting cancel's "partial output is not
    // preserved" contract.
    assert.equal(existsSync(jobDataPath(ws, job.id)), false, "canceled job must not persist a result data file");
  });

  it("error path does not flip canceled → failed", async () => {
    const job = createJobRecord(ws, "task", {});
    await assert.rejects(() =>
      runTrackedJob(ws, job, async () => {
        upsertJob(ws, { id: job.id, status: "canceled", errorMessage: "Canceled by user" });
        throw new Error("session aborted");
      })
    );
    const j = loadState(ws).jobs.find((x) => x.id === job.id);
    assert.equal(j.status, "canceled");
  });

  it("a normal run still completes", async () => {
    const job = createJobRecord(ws, "task", {});
    await runTrackedJob(ws, job, async () => ({ rendered: "done", summary: "done" }));
    const j = loadState(ws).jobs.find((x) => x.id === job.id);
    assert.equal(j.status, "completed");
    // A completed job DOES persist its result so result/oc_result can return it.
    assert.equal(existsSync(jobDataPath(ws, job.id)), true, "completed job must persist its result data file");
  });
});
