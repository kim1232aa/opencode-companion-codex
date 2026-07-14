import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatToolActivity,
  extractActivityLines,
} from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";
import { renderStatus } from "../plugins/opencode-companion/scripts/lib/render.mjs";

// Build a tool part in the shape OpenCode's /session/:id/message returns.
const toolPart = (tool, input, { id = `prt_${tool}_${Math.random().toString(36).slice(2)}`, status = "completed" } = {}) => ({
  id,
  type: "tool",
  tool,
  state: { status, input },
});
// An assistant message carrying tool parts, timestamped `created`.
const msg = (parts, created = 1000) => ({ info: { role: "assistant", time: { created } }, parts });

describe("formatToolActivity — single-line activity extraction", () => {
  it("bash → command", () => {
    assert.equal(formatToolActivity(toolPart("bash", { command: "npm test" })), "bash: npm test");
  });

  it("edit/read/write → file path", () => {
    assert.equal(formatToolActivity(toolPart("edit", { filePath: "src/foo.mjs" })), "edit: src/foo.mjs");
    assert.equal(formatToolActivity(toolPart("read", { filePath: "README.md" })), "read: README.md");
    assert.equal(formatToolActivity(toolPart("write", { path: "a/b.txt" })), "write: a/b.txt");
  });

  it("grep/glob → pattern; webfetch → url", () => {
    assert.equal(formatToolActivity(toolPart("grep", { pattern: "TODO" })), "grep: TODO");
    assert.equal(formatToolActivity(toolPart("webfetch", { url: "https://x.dev" })), "webfetch: https://x.dev");
  });

  it("collapses newlines to a single line and truncates long commands", () => {
    const long = "echo " + "x".repeat(200);
    const out = formatToolActivity(toolPart("bash", { command: `${long}\n\tmore` }));
    assert.ok(!out.includes("\n"), "must be single line");
    assert.ok(out.length <= 101, `truncated (got ${out.length})`);
    assert.ok(out.endsWith("…"), "truncation marker");
  });

  it("marks an errored tool call with ✗", () => {
    const out = formatToolActivity(toolPart("bash", { command: "false" }, { status: "error" }));
    assert.match(out, /bash: false ✗$/);
  });

  it("skips a still-pending call with no input yet (empty string)", () => {
    assert.equal(formatToolActivity(toolPart("bash", {}, { status: "pending" })), "");
    assert.equal(formatToolActivity(toolPart("bash", null, { status: "pending" })), "");
  });

  it("returns '' for non-tool parts", () => {
    assert.equal(formatToolActivity({ type: "text", text: "hi" }), "");
    assert.equal(formatToolActivity(null), "");
  });

  it("falls back to a bare tool name when a completed call has no known field", () => {
    const out = formatToolActivity(toolPart("mysterytool", { weird: 1 }, { status: "completed" }));
    // No recognized string field, but status is not pending ⇒ still surface the tool.
    assert.equal(out, "mysterytool");
  });
});

describe("extractActivityLines — incremental de-dup + since filter", () => {
  it("extracts activity lines in order, ignoring non-tool parts", () => {
    const messages = [
      msg([
        { type: "text", text: "let me look" },
        toolPart("read", { filePath: "README.md" }),
        toolPart("bash", { command: "npm test" }),
      ]),
    ];
    assert.deepEqual(extractActivityLines(messages), ["read: README.md", "bash: npm test"]);
  });

  it("does NOT re-emit a tool part already seen (same part id across polls)", () => {
    const seen = new Set();
    const messages1 = [msg([toolPart("bash", { command: "npm ci" }, { id: "p1" })])];
    const first = extractActivityLines(messages1, { seen });
    assert.deepEqual(first, ["bash: npm ci"]);

    // Same part reappears (now "completed"), plus a NEW part.
    const messages2 = [
      msg([
        toolPart("bash", { command: "npm ci" }, { id: "p1" }),
        toolPart("edit", { filePath: "x.mjs" }, { id: "p2" }),
      ]),
    ];
    const second = extractActivityLines(messages2, { seen });
    assert.deepEqual(second, ["edit: x.mjs"], "only the new part re-emits");
  });

  it("de-dupes an id-less tool part by its rendered line so it isn't re-emitted every poll", () => {
    const seen = new Set();
    const noId = (tool, input) => { const p = toolPart(tool, input); delete p.id; return p; };
    const messages = [msg([noId("bash", { command: "npm test" })])];
    assert.deepEqual(extractActivityLines(messages, { seen }), ["bash: npm test"]);
    // The same id-less command reappears on the next poll → must NOT re-emit.
    assert.deepEqual(extractActivityLines(messages, { seen }), []);
  });

  it("leaves a pending-no-input part un-seen so a later poll catches its command", () => {
    const seen = new Set();
    const pending = [msg([toolPart("bash", {}, { id: "p9", status: "pending" })])];
    assert.deepEqual(extractActivityLines(pending, { seen }), []);
    assert.equal(seen.has("p9"), false, "not marked seen while it had nothing to show");

    const filled = [msg([toolPart("bash", { command: "make" }, { id: "p9", status: "running" })])];
    assert.deepEqual(extractActivityLines(filled, { seen }), ["bash: make"]);
  });

  it("since drops tool parts from turns older than the current dispatch", () => {
    const messages = [
      msg([toolPart("bash", { command: "OLD" })], 500), // pre-dispatch
      msg([toolPart("bash", { command: "NEW" })], 2000), // after dispatch
    ];
    assert.deepEqual(extractActivityLines(messages, { since: 1000 }), ["bash: NEW"]);
  });

  it("treats a missing timestamp as pre-dispatch when since is active", () => {
    const messages = [{ info: { role: "assistant", time: {} }, parts: [toolPart("bash", { command: "X" })] }];
    assert.deepEqual(extractActivityLines(messages, { since: 1000 }), []);
  });

  it("tolerates junk input (non-array messages, missing parts)", () => {
    assert.deepEqual(extractActivityLines(null), []);
    assert.deepEqual(extractActivityLines([{ info: { role: "assistant" } }]), []);
  });
});

describe("renderStatus — surfaces recent activity lines under a running job", () => {
  it("shows the last 1-2 tool activity lines, not a flood", () => {
    const now = new Date().toISOString();
    const preview = [
      `[${now}] activity: read: README.md`,
      `[${now}] activity: edit: src/a.mjs`,
      `[${now}] activity: bash: npm test`,
      `[${now}] heartbeat: 12,000 tokens so far (3 turns)`,
    ].join("\n");
    const out = renderStatus({
      running: [{ id: "task-x", type: "task", status: "running", phase: "investigating", elapsed: "1m", progressPreview: preview }],
      recent: [], latestFinished: null,
    });
    // token count still shown in the header bits
    assert.match(out, /12,000 OpenCode tokens/);
    // most recent two activity lines surface (bash + edit), README (oldest) trimmed
    assert.match(out, /↳ bash: npm test/);
    assert.match(out, /↳ edit: src\/a\.mjs/);
    assert.ok(!out.includes("↳ read: README.md"), "only the last 2 activities are shown");
  });

  it("running job with no activity lines still renders without error", () => {
    const now = new Date().toISOString();
    const out = renderStatus({
      running: [{ id: "task-y", type: "task", status: "running", elapsed: "10s", progressPreview: `[${now}] heartbeat: 0 tokens` }],
      recent: [], latestFinished: null,
    });
    assert.match(out, /task-y/);
    assert.ok(!out.includes("↳"), "no activity marker when there are no activity lines");
  });
});
