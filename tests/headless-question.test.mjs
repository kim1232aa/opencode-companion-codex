import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildTaskPrompt, HEADLESS_HEADER, SAFETY_HEADER } from "../plugins/opencode-companion/scripts/lib/prompts.mjs";
import { dispatchWithRetry, watchAndRejectQuestions } from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";

// Regression cover for the headless hang: a model calls OpenCode's `question`
// tool, nobody is there to answer, the turn parks until the stall watchdog kills
// it — and the retry parks the same way. Three layers are asserted here:
//   1. the task prompt tells the model not to ask in the first place,
//   2. the runtime auto-rejects a question that gets asked anyway,
//   3. a stall that follows a `question` call is REPORTED as such.

const extract = (r) => (r && typeof r.text === "string" ? r.text : "");

describe("buildTaskPrompt — headless instruction", () => {
  it("tells the model it is unattended and must not ask questions", () => {
    const p = buildTaskPrompt("refactor the parser", { write: true });
    assert.match(p, /UNATTENDED/);
    assert.match(p, /NO human/i);
    assert.match(p, /Do NOT call any question \/ ask \/ clarification tool/);
    assert.match(p, /do NOT wait for user input/i);
    // The prescribed behavior on ambiguity: assume, say so, continue.
    assert.match(p, /most reasonable interpretation/i);
    assert.match(p, /state that assumption explicitly/i);
    assert.match(p, /Never end your turn with a question/i);
  });

  it("carries the headless instruction in read-only mode too", () => {
    const p = buildTaskPrompt("find the bug", {});
    assert.ok(p.includes(HEADLESS_HEADER), "read-only prompts are dispatched headlessly as well");
    assert.match(p, /This is a read-only investigation/);
  });

  it("keeps the verbatim-task-text contract: the instruction is a system prefix", () => {
    // The header must sit ABOVE the task and leave it untouched — the dispatch
    // promise is that task text is forwarded verbatim.
    const task = "Do NOT call any question tool — this literal text must survive.";
    const p = buildTaskPrompt(task, { write: true });
    assert.ok(p.endsWith(task), "task text is forwarded verbatim, as the trailing block");
    assert.ok(p.indexOf(HEADLESS_HEADER) < p.indexOf(task), "instruction precedes the task");
    assert.ok(p.indexOf(SAFETY_HEADER) < p.indexOf(HEADLESS_HEADER), "safety header stays first");
  });

  it("names no private provider or model (this is a public plugin)", () => {
    assert.doesNotMatch(HEADLESS_HEADER, /glm|zhipu|deepseek|kimi|qwen|anthropic|claude|openai|gpt/i);
  });
});

// --- runtime fallback -------------------------------------------------------
// watchAndRejectQuestions polls GET /question and POSTs /question/:id/reject.
// Both endpoints are real (verified against opencode 1.17.18); these tests drive
// them through a stubbed global fetch.

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Wait until `pred()` is true, or give up. Keeps these tests off fixed sleeps. */
async function waitFor(pred, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

describe("watchAndRejectQuestions — auto-reject a headless `question`", () => {
  let realFetch;
  let realWrite;
  let stderr;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    realWrite = process.stderr.write;
    stderr = [];
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.stderr.write = realWrite;
  });

  it("rejects a pending question belonging to this session", async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push(`${init.method ?? "GET"} ${u}`);
      if (u.endsWith("/question")) {
        return jsonRes([
          {
            id: "que_1",
            sessionID: "ses_mine",
            questions: [{ question: "Which database should I drop?", header: "Drop DB?", options: [] }],
          },
        ]);
      }
      return jsonRes(true);
    };

    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    const ok = await waitFor(() => calls.some((c) => c.startsWith("POST")));
    w.stop();

    assert.ok(ok, `no reject was posted; calls: ${calls.join(", ")}`);
    assert.ok(
      calls.includes("POST http://127.0.0.1:4096/question/que_1/reject"),
      `expected a reject POST, got: ${calls.join(", ")}`,
    );
    // We reject; we never answer on the user's behalf.
    assert.ok(!calls.some((c) => c.includes("/reply")), "must not answer the question for the user");
    assert.match(stderr.join(""), /auto-rejected a 'question' tool call/);
    assert.match(stderr.join(""), /Drop DB\?/, "logs what was asked");
  });

  it("ignores a question belonging to a different session", async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push(`${init.method ?? "GET"} ${u}`);
      if (u.endsWith("/question")) {
        return jsonRes([{ id: "que_other", sessionID: "ses_someone_else", questions: [] }]);
      }
      return jsonRes(true);
    };

    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    await waitFor(() => calls.length >= 2, 200); // let it poll a couple of times
    w.stop();

    assert.ok(!calls.some((c) => c.startsWith("POST")), `rejected another session's question: ${calls.join(", ")}`);
  });

  it("rejects a given question only once", async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push(`${init.method ?? "GET"} ${u}`);
      // The server keeps listing it (a slow resolve); we must not re-reject.
      if (u.endsWith("/question")) {
        return jsonRes([{ id: "que_1", sessionID: "ses_mine", questions: [] }]);
      }
      return jsonRes(true);
    };

    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    await waitFor(() => calls.filter((c) => c.startsWith("POST")).length >= 1);
    // Force several more poll turns by hand — the real interval is 3s.
    await waitFor(() => false, 60);
    w.stop();

    const rejects = calls.filter((c) => c.startsWith("POST"));
    assert.equal(rejects.length, 1, `rejected more than once: ${rejects.join(", ")}`);
  });

  it("retries a reject that fails with a transient 5xx", async () => {
    const calls = [];
    let rejectAttempts = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push(`${init.method ?? "GET"} ${u}`);
      if (u.endsWith("/question")) {
        return jsonRes([{ id: "que_1", sessionID: "ses_mine", questions: [] }]);
      }
      rejectAttempts++;
      // First attempt: server hiccup. It must NOT be marked handled.
      return rejectAttempts === 1 ? jsonRes(null, 503) : jsonRes(true);
    };

    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    // Needs a second poll (3s later) to retry, so allow for the real interval.
    const ok = await waitFor(() => rejectAttempts >= 2, 5000);
    w.stop();

    assert.ok(ok, `a 5xx reject was never retried (attempts: ${rejectAttempts})`);
    assert.match(stderr.join(""), /got HTTP 503; will retry/);
  });

  it("does NOT treat a 400 reject as 'resolved' — our request failed, so it retries", async () => {
    // A 400 means OUR reject was rejected — the question is STILL pending. Marking
    // it handled would falsely claim we rejected a prompt that is still hanging the
    // session (the exact hang this watcher exists to prevent). Only 404/409 = gone.
    let rejectAttempts = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/question")) return jsonRes([{ id: "que_1", sessionID: "ses_mine", questions: [] }]);
      rejectAttempts++;
      return rejectAttempts === 1 ? jsonRes(null, 400) : jsonRes(true);
    };
    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    const ok = await waitFor(() => rejectAttempts >= 2, 5000);
    w.stop();
    assert.ok(ok, `a 400 reject was wrongly treated as resolved and never retried (attempts: ${rejectAttempts})`);
    assert.match(stderr.join(""), /got HTTP 400; will retry/);
  });

  it("treats a 404 reject (question already gone) as resolved — handled, not retried", async () => {
    let rejectAttempts = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/question")) return jsonRes([{ id: "que_1", sessionID: "ses_mine", questions: [] }]);
      rejectAttempts++;
      return jsonRes({ error: "QuestionNotFound" }, 404);
    };
    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    await waitFor(() => stderr.join("").includes("auto-rejected"), 3000);
    w.stop();
    assert.match(stderr.join(""), /auto-rejected a 'question' tool call/, "a 404 (gone) counts as resolved");
    assert.equal(rejectAttempts, 1, "a resolved question is not re-rejected");
  });

  it("is a no-op against a server with no /question endpoint (older build)", async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      return jsonRes({ error: "not found" }, 404);
    };

    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    await waitFor(() => calls.length >= 1);
    w.stop();

    assert.ok(!calls.some((c) => c.startsWith("POST")), "nothing to reject when the endpoint is absent");
    assert.doesNotMatch(stderr.join(""), /auto-rejected/);
  });

  it("survives a poll that throws (transient network failure)", async () => {
    let polls = 0;
    globalThis.fetch = async () => { polls++; throw new Error("ECONNRESET"); };

    const w = watchAndRejectQuestions("http://127.0.0.1:4096", {}, "ses_mine");
    const ok = await waitFor(() => polls >= 1);
    w.stop();

    assert.ok(ok, "the watcher died on a transient poll failure");
  });
});

describe("dispatchWithRetry — a stall after `question` is explained, not just reported", () => {
  /**
   * A client whose token count never moves (so the watchdog trips) and whose
   * activity stream reports `lastTool` once per attempt.
   */
  function stallingClient(lastTool) {
    const waiters = new Map();
    return {
      createSession: async () => ({ id: `s${Math.random().toString(36).slice(2)}` }),
      getSessionUsage: async () => ({ total: 100, output: 0, turns: 1 }), // frozen ⇒ stalls
      abortSession: async (sid) => { waiters.get(sid)?.(); },
      getSessionActivity: async (_sid, { seen } = {}) => {
        if (seen && !seen.has("t1")) { seen.add("t1"); return [lastTool]; }
        return [];
      },
      sendPrompt: async (sid) => {
        await new Promise((r) => waiters.set(sid, r));
        return { text: "" }; // resolves empty once the watchdog aborts it
      },
    };
  }

  const run = (client, logs) => dispatchWithRetry({
    client, prompt: "x", agent: "build", extract,
    log: (m) => logs.push(m),
    makeSession: () => client.createSession(),
    beatMs: 10, stallMs: 25, backoffMs: 1,
  });

  it("names the real cause when the last tool was `question`", async () => {
    const logs = [];
    await assert.rejects(
      run(stallingClient("question"), logs),
      (err) =>
        // the existing stall contract is preserved …
        /Stalled \(no token progress\) on every one of 3 attempts/.test(err.message) &&
        // … and now says WHY, and what to do about it
        /waiting for a human/i.test(err.message) &&
        /unattended dispatch/i.test(err.message) &&
        /Spell the task out more explicitly/i.test(err.message),
    );
    assert.ok(
      logs.some((l) => /stalled/.test(l) && /waiting for a human/i.test(l)),
      `the stall log should explain itself:\n${logs.join("\n")}`,
    );
  });

  it("leaves an ordinary stall message alone when the last tool was not a question", async () => {
    const logs = [];
    await assert.rejects(
      run(stallingClient("bash: npm test"), logs),
      (err) =>
        /Stalled \(no token progress\) on every one of 3 attempts/.test(err.message) &&
        !/waiting for a human/i.test(err.message),
    );
    assert.ok(!logs.some((l) => /waiting for a human/i.test(l)), "no question hint on a plain stall");
  });
});
