// Return-path correctness: what a delegation REPORTS must match what this run
// actually did.
//
// 1. getSessionUsage(since): a RESUMED session carries the previous task's
//    turns; without the window the trailer summed them into this run's
//    tokens/cost (usage inflation).
// 2. getSessionResult(until): two stranded jobs can share one session
//    (--resume-last); without an upper bound the older job's probe returned the
//    NEWER job's answer.
// 3. extractResponseText: an unknown response shape must read as EMPTY (honest
//    failure) — the old JSON.stringify fallback made it a "successful" answer
//    consisting of a raw JSON dump.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createClient } from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";
import { extractResponseText } from "../plugins/opencode-companion/scripts/oc-companion.mjs";

const T0 = 1_000_000; // old task's turn
const T1 = 2_000_000; // this run's turn
const T2 = 3_000_000; // a LATER job's turn on the same session

const MESSAGES = [
  { info: { role: "assistant", time: { created: T0, completed: T0 + 10 }, tokens: { input: 100, output: 50 }, cost: 1, providerID: "p", modelID: "m" },
    parts: [{ type: "text", text: "old answer" }] },
  { info: { role: "assistant", time: { created: T1, completed: T1 + 10 }, tokens: { input: 10, output: 5 }, cost: 0.1, providerID: "p", modelID: "m" },
    parts: [{ type: "text", text: "this run's answer" }] },
  { info: { role: "assistant", time: { created: T2, completed: T2 + 10 }, tokens: { input: 20, output: 7 }, cost: 0.2, providerID: "p", modelID: "m" },
    parts: [{ type: "text", text: "later job's answer" }] },
];

let server, baseUrl;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(MESSAGES));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe("getSessionUsage — since window", () => {
  it("without since: sums the whole session (back-compat)", async () => {
    const u = await createClient(baseUrl).getSessionUsage("s1");
    assert.equal(u.output, 62);
    assert.equal(u.turns, 3);
  });

  it("with since: only THIS run's turns count (no resume inflation)", async () => {
    const u = await createClient(baseUrl).getSessionUsage("s1", { since: T1 });
    assert.equal(u.output, 12, "old turn excluded; this run + later turns included");
    assert.equal(u.turns, 2);
    const u2 = await createClient(baseUrl).getSessionUsage("s1", { since: T1, timeoutMs: 5000 });
    assert.equal(u2.cost.toFixed(1), "0.3");
  });
});

describe("getSessionUsage — since window fails OPEN on timestamp-less builds", () => {
  // Adversarially found regression: a build that omits info.time.created (or
  // stamps it in seconds) had the since-filter drop EVERY turn → all-zero
  // usage → the trailer (and its model-mismatch ⚠️) silently vanished on a run
  // that really spent tokens. When the window matches nothing but assistant
  // turns exist, the whole-session sum is returned instead.
  let s2, url2;
  before(async () => {
    const NO_TS = [
      { info: { role: "assistant", tokens: { input: 100, output: 40 }, cost: 1, providerID: "p", modelID: "m" },
        parts: [{ type: "text", text: "a" }] },
      { info: { role: "assistant", time: { created: 1_700_000 }, tokens: { input: 10, output: 2 }, cost: 0.1, providerID: "p", modelID: "m" },
        parts: [{ type: "text", text: "b" }] }, // "seconds-unit" stamp — far below an ms-epoch since
    ];
    s2 = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(NO_TS)); });
    await new Promise((r) => s2.listen(0, "127.0.0.1", r));
    url2 = `http://127.0.0.1:${s2.address().port}`;
  });
  after(() => s2.close());

  it("falls back to the full-session sum instead of reporting zero", async () => {
    const u = await createClient(url2).getSessionUsage("s", { since: Date.now() });
    assert.equal(u.turns, 2, "must not report an empty run");
    assert.equal(u.output, 42);
    assert.equal(u.model, "p/m", "model (and the mismatch warning) must not vanish");
  });

  it("a normal ms-timestamp build still gets the window", async () => {
    const u = await createClient(baseUrl).getSessionUsage("s1", { since: T1 });
    assert.equal(u.turns, 2, "window still applies when it matches something");
  });
});

describe("getSessionResult — since/until window", () => {
  it("picks THIS job's answer, not a later job's, when until bounds the window", async () => {
    const r = await createClient(baseUrl).getSessionResult("s1", { since: T1, until: T2 - 1 });
    assert.equal(r.text, "this run's answer");
  });

  it("unbounded still returns the latest completed turn", async () => {
    const r = await createClient(baseUrl).getSessionResult("s1", { since: T1 });
    assert.equal(r.text, "later job's answer");
  });
});

describe("extractResponseText — unknown shape is EMPTY, not a JSON dump", () => {
  it("returns '' for an unrecognized response object", () => {
    assert.equal(extractResponseText({ some: "unknown", shape: [1, 2, 3] }), "");
  });

  it("still extracts the normal shapes", () => {
    assert.equal(extractResponseText({ parts: [{ type: "text", text: "hi" }] }), "hi");
    assert.equal(extractResponseText("plain"), "plain");
    assert.equal(extractResponseText(null), "");
  });
});
