// The OUTPUT BUDGET.
//
// Why it exists: a delegated job's WORK runs on OpenCode and costs the caller
// nothing, but its ANSWER is returned into the caller's context and re-read on
// every later turn — so the answer is the one part of a delegation that keeps
// billing. buildTaskPrompt used to carry no length constraint at all, and models
// routinely returned an essay where a conclusion plus a file:line would do.
//
// What must NOT break in the process:
//   - the task text is still forwarded VERBATIM as the trailing block,
//   - SAFETY_HEADER and HEADLESS_HEADER still lead,
//   - the budget constrains the REPORT, never the work,
//   - a review's JSON schema contract is untouched.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildTaskPrompt,
  buildReviewPrompt,
  buildOutputBudget,
  wantsOutputBudget,
  OUTPUT_BUDGET_HEADER,
  DEFAULT_BRIEF,
  SAFETY_HEADER,
  HEADLESS_HEADER,
} from "../plugins/opencode-companion/scripts/lib/prompts.mjs";
import { readOutputBudget, handleDelegateBatch } from "../plugins/opencode-companion/scripts/oc-companion.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "opencode-companion");
const SERVER = path.join(PLUGIN_ROOT, "scripts", "oc-companion.mjs");

describe("buildOutputBudget", () => {
  it("is ON by default — the recurring cost is the answer, not the work", () => {
    assert.equal(DEFAULT_BRIEF, true);
    assert.ok(buildOutputBudget({}).includes(OUTPUT_BUDGET_HEADER));
  });

  it("is fully OFF when brief:false — the explicit escape hatch", () => {
    assert.equal(buildOutputBudget({ brief: false }), "");
  });

  it("adds a hard word cap when maxWords is given", () => {
    const budget = buildOutputBudget({ maxWords: 150 });
    assert.match(budget, /HARD LIMIT: keep the final answer under 150 words/);
    assert.match(budget, /where it can be read in full/);
    assert.match(budget, /never cut off mid-thought/i);
  });

  it("never smuggles a word cap into a run that opted out", () => {
    assert.equal(buildOutputBudget({ brief: false, maxWords: 50 }), "");
  });

  it("ignores a non-positive / non-numeric maxWords instead of emitting a broken limit", () => {
    for (const bad of [0, -10, "abc", NaN, undefined, null]) {
      const budget = buildOutputBudget({ maxWords: bad });
      assert.ok(budget.includes(OUTPUT_BUDGET_HEADER), `budget still present for ${bad}`);
      assert.doesNotMatch(budget, /HARD LIMIT/, `no bogus cap for ${bad}`);
    }
  });

  it("constrains the REPORT, not the work, and says so", () => {
    const budget = buildOutputBudget({});
    assert.match(budget, /constrains what you REPORT, not how much work you do/);
    assert.match(budget, /Investigate as deeply as the task needs/);
  });

  it("asks for conclusion + locators, and bans the padding", () => {
    const budget = buildOutputBudget({});
    assert.match(budget, /lead with the conclusion/i);
    assert.match(budget, /file:line/);
    assert.match(budget, /instead of reproducing whole files, whole diffs or long logs/);
    assert.match(budget, /no preamble/i);
    assert.match(budget, /Write at length ONLY where the task explicitly asks/);
  });

  it("explains WHY (the answer is re-read every turn), so the model can weigh it", () => {
    assert.match(OUTPUT_BUDGET_HEADER, /STAYS in that agent's context/);
    assert.match(OUTPUT_BUDGET_HEADER, /re-read on every\s+later turn/);
  });

  it("adds the schema-safe clause only when the caller imposes an output contract", () => {
    assert.doesNotMatch(buildOutputBudget({}), /does NOT relax/);
    const structured = buildOutputBudget({ structured: true });
    assert.match(structured, /applies to the PROSE inside the required output fields/);
    assert.match(structured, /still return every required field/);
  });

  it("names no private provider or model (this is a public plugin)", () => {
    assert.doesNotMatch(
      buildOutputBudget({ maxWords: 100, structured: true }),
      /glm|zhipu|deepseek|kimi|qwen|anthropic|claude|openai|gpt|gemini/i
    );
  });
});

describe("wantsOutputBudget — the opt-in test used where the budget is not defaulted", () => {
  it("is false when the caller said nothing", () => {
    assert.equal(wantsOutputBudget({}), false);
    assert.equal(wantsOutputBudget({ brief: false }), false);
  });

  it("is true on an explicit brief, or on any positive word cap", () => {
    assert.equal(wantsOutputBudget({ brief: true }), true);
    assert.equal(wantsOutputBudget({ maxWords: 200 }), true);
    assert.equal(wantsOutputBudget({ maxWords: 0 }), false);
  });
});

describe("buildTaskPrompt — output budget", () => {
  it("carries the budget by default, in both write and read-only modes", () => {
    assert.ok(buildTaskPrompt("fix the parser", { write: true }).includes(OUTPUT_BUDGET_HEADER));
    assert.ok(buildTaskPrompt("find the bug", {}).includes(OUTPUT_BUDGET_HEADER));
  });

  it("drops the budget entirely when the caller asks for the long form", () => {
    const p = buildTaskPrompt("write the full migration guide", { write: true, brief: false });
    assert.ok(!p.includes(OUTPUT_BUDGET_HEADER));
    assert.ok(p.includes(SAFETY_HEADER));
    assert.ok(p.includes(HEADLESS_HEADER));
    assert.ok(p.endsWith("write the full migration guide"));
  });

  it("passes a word cap through to the prompt", () => {
    assert.match(buildTaskPrompt("audit auth", { maxWords: 200 }), /under 200 words/);
  });

  it("KEEPS the verbatim-task-text contract: the budget is a system prefix", () => {
    const task = "Write a 5000-word report. Do NOT be brief. HARD LIMIT: none.";
    const p = buildTaskPrompt(task, { write: true, maxWords: 100 });

    assert.ok(p.endsWith(task), "task text is forwarded verbatim, as the trailing block");
    assert.ok(p.indexOf(OUTPUT_BUDGET_HEADER) < p.indexOf(task), "budget precedes the task");
    assert.ok(p.indexOf(SAFETY_HEADER) < p.indexOf(HEADLESS_HEADER), "safety header stays first");
    assert.ok(p.indexOf(HEADLESS_HEADER) < p.indexOf(OUTPUT_BUDGET_HEADER), "headless header stays second");
  });
});

describe("buildReviewPrompt — the budget is OPT-IN and never breaks the JSON contract", () => {
  it("adds nothing when not asked (review output is already schema-bounded)", async () => {
    const p = await buildReviewPrompt(REPO_ROOT, {}, PLUGIN_ROOT);
    assert.ok(!p.includes(OUTPUT_BUDGET_HEADER));
    assert.match(p, /<output_schema>/);
  });

  it("tightens the prose when asked, with the schema block still LAST", async () => {
    const p = await buildReviewPrompt(REPO_ROOT, { brief: true, maxWords: 300 }, PLUGIN_ROOT);
    assert.ok(p.includes(OUTPUT_BUDGET_HEADER));
    assert.match(p, /under 300 words/);
    assert.match(p, /applies to the PROSE inside the required output fields/);
    assert.ok(p.indexOf(OUTPUT_BUDGET_HEADER) < p.indexOf("<output_schema>"), "the schema block stays last");
    assert.match(p, /Return ONLY a single JSON object/);
    assert.ok(p.trimEnd().endsWith("</output_schema>"));
  });
});

describe("readOutputBudget — MCP argument validation", () => {
  it("passes an unset budget through as undefined (the default lives in prompts.mjs)", () => {
    assert.deepEqual(readOutputBudget({}), { brief: undefined, maxWords: undefined });
  });

  it("accepts a boolean brief and a positive maxWords", () => {
    assert.deepEqual(readOutputBudget({ brief: true }), { brief: true, maxWords: undefined });
    assert.deepEqual(readOutputBudget({ maxWords: 200 }), { brief: undefined, maxWords: 200 });
    assert.deepEqual(readOutputBudget({ maxWords: 200.7 }), { brief: undefined, maxWords: 200 });
  });

  it("rejects a malformed budget instead of silently ignoring it", () => {
    assert.match(readOutputBudget({ brief: "yes" }).error, /brief, if supplied, must be a boolean/);
    assert.match(readOutputBudget({ maxWords: 0 }).error, /maxWords, if supplied, must be a positive number/);
    assert.match(readOutputBudget({ maxWords: "lots" }).error, /positive number/);
  });

  it("drops the cap when the caller explicitly opted out of brief", () => {
    assert.deepEqual(readOutputBudget({ brief: false, maxWords: 50 }), { brief: false, maxWords: undefined });
  });
});

describe("oc_delegate_batch — the budget reaches every task", () => {
  it("forwards each item's brief/maxWords to its delegation", async () => {
    const seen = [];
    await handleDelegateBatch(
      {
        tasks: [
          { task: "A", model: "p/a", maxWords: 120 },
          { task: "B", model: "p/b", brief: false },
          { task: "C", model: "p/c" },
        ],
        workspace: tmpdir(),
      },
      undefined,
      {
        ensureServer: async () => ({}),
        handleDelegate: async (args) => {
          seen.push({ task: args.task, brief: args.brief, maxWords: args.maxWords });
          return { content: [{ type: "text", text: "ok" }] };
        },
      }
    );

    assert.deepEqual(seen, [
      { task: "A", brief: undefined, maxWords: 120 },
      { task: "B", brief: false, maxWords: undefined },
      { task: "C", brief: undefined, maxWords: undefined },
    ]);
  });

  it("rejects a malformed budget BEFORE any task in the batch is dispatched", async () => {
    let delegated = 0;
    const res = await handleDelegateBatch(
      { tasks: [{ task: "A" }, { task: "B", maxWords: -5 }], workspace: tmpdir() },
      undefined,
      {
        ensureServer: async () => ({}),
        handleDelegate: async () => { delegated++; return { content: [{ type: "text", text: "ok" }] }; },
      }
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /tasks\[1\]\.maxWords/);
    assert.equal(delegated, 0, "task A must not burn a run before the bad arg is caught");
  });
});

// ------------------------------------------------------------------
// The tool schemas, as Codex actually sees them (tools/list over stdio)
// ------------------------------------------------------------------

describe("tools/list — the budget is discoverable, with the cost explained", () => {
  let proc;
  let tools;

  before(async () => {
    proc = spawn("node", [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_COMPANION_DATA: mkdtempSync(path.join(tmpdir(), "oc-budget-test-")),
        OPENCODE_SERVER_PORT: "1",
      },
    });
    tools = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("timeout waiting for tools/list")), 10000);
      proc.stdout.on("data", (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            clearTimeout(timer);
            resolve(msg.result.tools);
          }
        }
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    });
  });

  after(() => proc?.kill("SIGKILL"));

  const tool = (name) => tools.find((t) => t.name === name);

  it("exposes brief + maxWords on oc_delegate", () => {
    const props = tool("oc_delegate").inputSchema.properties;
    assert.equal(props.brief.type, "boolean");
    assert.equal(props.maxWords.type, "number");
    // The description has to carry the WHY, or a model has no basis to keep it on.
    assert.match(props.brief.description, /Defaults to TRUE/);
    assert.match(props.brief.description, /re-read on every later turn/);
    assert.match(props.brief.description, /never limits how much WORK is done/);
  });

  it("tells the caller, in the tool description, that the result occupies ITS context", () => {
    assert.match(tool("oc_delegate").description, /returned into your context and re-read on every later turn/);
    assert.match(tool("oc_delegate").description, /capped by default \(brief\)/);
    assert.match(tool("oc_delegate_batch").description, /N tasks means N answers to carry/);
  });

  it("exposes brief + maxWords on each oc_delegate_batch item", () => {
    const item = tool("oc_delegate_batch").inputSchema.properties.tasks.items.properties;
    assert.equal(item.brief.type, "boolean");
    assert.equal(item.maxWords.type, "number");
  });

  it("exposes them on the reviews too, marked OPT-IN and schema-safe", () => {
    for (const name of ["oc_review", "oc_adversarial_review"]) {
      const props = tool(name).inputSchema.properties;
      assert.equal(props.brief.type, "boolean");
      assert.equal(props.maxWords.type, "number");
      assert.match(props.brief.description, /OPT-IN|already bounded by the schema/);
      assert.match(props.brief.description, /required field|schema/i);
    }
  });
});
