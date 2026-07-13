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

  it("lists the six tools with schemas", async () => {
    const res = await srv.call("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["oc_cancel", "oc_delegate", "oc_delegate_batch", "oc_result", "oc_setup", "oc_status"]);
    const delegate = res.result.tools.find((t) => t.name === "oc_delegate");
    assert.deepEqual(delegate.inputSchema.required, ["task"]);
    const batch = res.result.tools.find((t) => t.name === "oc_delegate_batch");
    assert.deepEqual(batch.inputSchema.required, ["tasks"]);
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
