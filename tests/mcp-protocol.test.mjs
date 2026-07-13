// End-to-end MCP protocol test: spawn the real oc-companion.mjs and speak
// newline-delimited JSON-RPC to it, exactly as Codex's MCP client would.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "plugins", "opencode-companion", "scripts", "oc-companion.mjs"
);

function startServer() {
  const proc = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_COMPANION_DATA: mkdtempSync(path.join(tmpdir(), "oc-mcp-test-")),
      // Point at a dead port so no test accidentally reaches a real server.
      OPENCODE_SERVER_PORT: "1",
    },
  });
  const pending = new Map();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });
  let nextId = 1;
  const call = (method, params, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { proc, call, notify };
}

describe("oc-companion MCP server", () => {
  let srv;
  before(() => { srv = startServer(); });
  after(() => { srv.proc.kill("SIGKILL"); });

  it("answers initialize with protocol version, serverInfo, and instructions", async () => {
    const res = await srv.call("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(res.result.protocolVersion, "2025-03-26");
    assert.equal(res.result.serverInfo.name, "opencode-companion");
    assert.match(res.result.instructions, /oc_delegate/);
    srv.notify("notifications/initialized", {});
  });

  it("lists all nine tools with schemas", async () => {
    const res = await srv.call("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "oc_adversarial_review",
      "oc_cancel",
      "oc_delegate",
      "oc_delegate_batch",
      "oc_result",
      "oc_resume_candidate",
      "oc_review",
      "oc_setup",
      "oc_status",
    ]);
    const delegate = res.result.tools.find((t) => t.name === "oc_delegate");
    assert.deepEqual(delegate.inputSchema.required, ["task"]);
    const batch = res.result.tools.find((t) => t.name === "oc_delegate_batch");
    assert.deepEqual(batch.inputSchema.required, ["tasks"]);
    // Reviews take only optional params (no required), and expose base/model.
    const review = res.result.tools.find((t) => t.name === "oc_review");
    assert.equal(review.inputSchema.required, undefined);
    assert.ok(review.inputSchema.properties.base && review.inputSchema.properties.model);
    const adv = res.result.tools.find((t) => t.name === "oc_adversarial_review");
    assert.ok(adv.inputSchema.properties.focus, "adversarial review exposes a focus param");
    const resume = res.result.tools.find((t) => t.name === "oc_resume_candidate");
    assert.ok(resume.inputSchema.properties.workspace);
  });

  it("oc_review rejects a bad model and an unsafe base without touching a server", async () => {
    const badModel = await srv.call("tools/call", { name: "oc_review", arguments: { model: "  " } });
    assert.equal(badModel.result.isError, true);
    assert.match(badModel.result.content[0].text, /model/);
    // An unsafe base ref must be rejected by validation, not shelled out to git.
    const badBase = await srv.call("tools/call", { name: "oc_review", arguments: { base: "main; rm -rf /" } });
    assert.equal(badBase.result.isError, true);
    assert.match(badBase.result.content[0].text, /invalid base ref/);
  });

  it("oc_adversarial_review rejects an empty base string", async () => {
    const res = await srv.call("tools/call", { name: "oc_adversarial_review", arguments: { base: "   " } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /base/);
  });

  it("oc_resume_candidate reports nothing to resume for an empty workspace", async () => {
    const res = await srv.call("tools/call", { name: "oc_resume_candidate", arguments: {} });
    assert.equal(res.result.isError, undefined);
    assert.match(res.result.content[0].text, /No resumable OpenCode task session/);
    // The machine-readable JSON payload is appended for the model to parse.
    assert.match(res.result.content[0].text, /"available":false/);
  });

  it("oc_delegate_batch validates its tasks array", async () => {
    const empty = await srv.call("tools/call", { name: "oc_delegate_batch", arguments: { tasks: [] } });
    assert.equal(empty.result.isError, true);
    const badItem = await srv.call("tools/call", { name: "oc_delegate_batch", arguments: { tasks: [{ label: "x" }] } });
    assert.equal(badItem.result.isError, true);
    assert.match(badItem.result.content[0].text, /tasks\[0\]\.task/);
  });

  it("rejects an unknown tool with -32601", async () => {
    const res = await srv.call("tools/call", { name: "nope", arguments: {} });
    assert.equal(res.error.code, -32601);
  });

  it("oc_delegate without task returns an isError result (not a crash)", async () => {
    const res = await srv.call("tools/call", { name: "oc_delegate", arguments: {} });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /task is required/);
  });

  it("oc_status answers cleanly with no jobs and an unreachable server", async () => {
    const res = await srv.call("tools/call", { name: "oc_status", arguments: {} });
    assert.equal(res.result.isError, undefined);
    assert.match(res.result.content[0].text, /No OpenCode jobs/);
  });

  it("oc_result reports no finished job for an empty workspace", async () => {
    const res = await srv.call("tools/call", { name: "oc_result", arguments: {} });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /No finished OpenCode job/);
  });

  it("oc_cancel reports nothing to cancel", async () => {
    const res = await srv.call("tools/call", { name: "oc_cancel", arguments: {} });
    assert.match(res.result.content[0].text, /No active job/);
  });

  it("oc_result validates the job ref shape", async () => {
    const res = await srv.call("tools/call", { name: "oc_result", arguments: { job: "../etc/passwd" } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /invalid job reference/);
  });

  it("answers ping", async () => {
    const res = await srv.call("ping", {});
    assert.deepEqual(res.result, {});
  });
});
