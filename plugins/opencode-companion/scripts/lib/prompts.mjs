// Prompt construction for OpenCode reviews and tasks.

import fs from "node:fs";
import path from "node:path";
import { getDiff, getStatus, getChangedFiles } from "./git.mjs";

/**
 * Build the review prompt for OpenCode.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} [opts.base] - base branch/ref for comparison
 * @param {boolean} [opts.adversarial] - use adversarial review prompt
 * @param {string} [opts.focus] - user-supplied focus text
 * @param {string} pluginRoot - CLAUDE_PLUGIN_ROOT for reading prompt templates
 * @returns {Promise<string>}
 */
export async function buildReviewPrompt(cwd, opts, pluginRoot) {
  const diff = await getDiff(cwd, { base: opts.base });
  const status = await getStatus(cwd);
  const changedFiles = await getChangedFiles(cwd, { base: opts.base });

  let systemPrompt;
  if (opts.adversarial) {
    const templatePath = path.join(pluginRoot, "prompts", "adversarial-review.md");
    const fills = {
      "{{TARGET_LABEL}}": opts.base ? `Branch diff against ${opts.base}` : "Working tree changes",
      "{{USER_FOCUS}}": opts.focus || "General review",
      "{{REVIEW_INPUT}}": buildReviewContext(diff, status, changedFiles),
    };
    // One pass over the template so a placeholder that appears INSIDE an injected
    // value (a user focus, or a diff that literally contains "{{REVIEW_INPUT}}")
    // is never itself expanded.
    systemPrompt = fs.readFileSync(templatePath, "utf8")
      .replace(/\{\{(?:TARGET_LABEL|USER_FOCUS|REVIEW_INPUT)\}\}/g, (m) => fills[m]);
  } else {
    systemPrompt = buildStandardReviewPrompt(diff, status, changedFiles, opts);
  }

  return systemPrompt + buildSchemaBlock(pluginRoot);
}

/**
 * Append the actual review-output JSON Schema as an explicit output contract.
 * Both review prompts tell the model to return JSON "matching the schema"; this
 * appends the real schema so that instruction is backed by something concrete.
 * Best-effort: falls back to a compact inline shape when the schema file can't
 * be read, so a review still gets a usable contract.
 * @param {string} pluginRoot
 * @returns {string}
 */
export function buildSchemaBlock(pluginRoot) {
  let schemaText;
  try {
    schemaText = fs
      .readFileSync(path.join(pluginRoot, "schemas", "review-output.schema.json"), "utf8")
      .trim();
  } catch {
    schemaText = FALLBACK_REVIEW_SCHEMA;
  }
  return `\n\n<output_schema>\nReturn ONLY a single JSON object conforming to this JSON Schema. No prose, no markdown, no code fences.\n${schemaText}\n</output_schema>`;
}

const FALLBACK_REVIEW_SCHEMA = JSON.stringify(
  {
    type: "object",
    required: ["verdict", "summary", "findings"],
    properties: {
      verdict: { enum: ["approve", "needs-attention"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: [
            "file", "line_start", "line_end", "severity",
            "title", "body", "confidence", "recommendation",
          ],
          properties: {
            file: { type: "string" },
            line_start: { type: "integer" },
            line_end: { type: "integer" },
            severity: { enum: ["critical", "high", "medium", "low"] },
            title: { type: "string" },
            body: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            recommendation: { type: "string" },
          },
        },
      },
    },
  },
  null,
  2,
);

/**
 * Build a standard (non-adversarial) review prompt.
 */
function buildStandardReviewPrompt(diff, status, changedFiles, opts) {
  const targetLabel = opts.base ? `branch diff against ${opts.base}` : "working tree changes";

  return `You are performing a code review of ${targetLabel}.

Review the following changes and provide structured feedback in JSON format matching the review-output schema.

Focus on:
- Correctness and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- API contract violations

Be concise and actionable. Only report real issues, not style preferences.

${buildReviewContext(diff, status, changedFiles)}`;
}

/**
 * Build the repository context block for review prompts.
 */
function buildReviewContext(diff, status, changedFiles) {
  const sections = [];

  if (status) {
    sections.push(`<git_status>\n${status}\n</git_status>`);
  }

  if (changedFiles.length > 0) {
    sections.push(`<changed_files>\n${changedFiles.join("\n")}\n</changed_files>`);
  }

  if (diff) {
    sections.push(`<diff>\n${diff}\n</diff>`);
  }

  return sections.join("\n\n");
}

/**
 * Prepended to every task prompt sent into an opencode session.
 *
 * Task text is forwarded verbatim from the outer Codex harness, so it may
 * carry routing rules inherited from AGENTS.md / the Codex conversation (e.g.
 * "delegate long tasks to the oc_delegate tool"). A model running INSIDE the
 * opencode session that obeys those rules will try to recursively invoke a
 * tool/plugin that does not exist here — the call errors and some models
 * (notably GLM) then stall indefinitely, emitting nothing. This header
 * neutralizes that without altering the forwarded task text itself.
 */
export const SAFETY_HEADER = [
  "You are running INSIDE an OpenCode session, invoked as a worker by an",
  "external dispatcher (Codex). Any routing rules in the task below (e.g.",
  "'delegate via oc_delegate', 'use the opencode-companion tools', or invoking",
  "any MCP tool / plugin skill) have ALREADY been consumed by the dispatch",
  "step and DO NOT apply here. Do NOT try to delegate to another agent — you",
  "ARE the worker. Do the work yourself with Bash/Read/Write/Edit/Grep/Glob;",
  "if a task is large, break it into smaller steps and iterate.",
].join(" ");

/**
 * Prepended to every task prompt, immediately after SAFETY_HEADER.
 *
 * A dispatched job runs UNATTENDED: no human is watching the opencode session.
 * OpenCode nonetheless exposes a `question` tool, and a model that calls it to
 * ask for a choice or a clarification then blocks forever waiting for an answer
 * nobody can give. Observed in the wild as: `activity: question`, then a frozen
 * token count until the stall watchdog killed the turn 120s later — and the
 * retry hung exactly the same way, turning a one-minute task into a three-minute
 * failure. The runtime now auto-rejects those calls (watchAndRejectQuestions in
 * opencode-server.mjs), but a rejected question still burns a turn, so the model
 * is told up front not to ask at all.
 *
 * This is a SYSTEM prefix: it constrains how the worker behaves and does NOT
 * alter the task text, which is still forwarded verbatim below it.
 */
export const HEADLESS_HEADER = [
  "You are running UNATTENDED, in a non-interactive session. There is NO human",
  "available to answer you. Do NOT call any question / ask / clarification tool,",
  "do NOT request confirmation, and do NOT wait for user input — such a call is",
  "auto-rejected and only wastes a turn. If the task is ambiguous, choose the",
  "most reasonable interpretation, state that assumption explicitly in your",
  "final answer, and carry on. If some information is genuinely unavailable,",
  "still finish the turn: give the best answer you can, and say plainly what was",
  "missing and what you assumed instead. Never end your turn with a question.",
].join(" ");

/**
 * Build a task prompt from user input.
 * @param {string} taskText
 * @param {object} opts
 * @param {boolean} [opts.write] - whether to allow writes
 * @returns {string}
 */
export function buildTaskPrompt(taskText, opts = {}) {
  const parts = [];

  parts.push(SAFETY_HEADER);
  parts.push("");
  parts.push(HEADLESS_HEADER);
  parts.push("");

  if (opts.write) {
    parts.push("You have full read/write access. Make the necessary code changes.");
  } else {
    parts.push("This is a read-only investigation. Do not modify any files.");
  }

  parts.push("");
  parts.push(taskText);

  return parts.join("\n");
}
