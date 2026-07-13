import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchemaBlock } from "../plugins/opencode-companion/scripts/lib/prompts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(here, "../plugins/opencode-companion");

function embeddedSchema(block) {
  return JSON.parse(block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1));
}

test("buildSchemaBlock injects the real review-output schema", () => {
  const block = buildSchemaBlock(PLUGIN_ROOT);
  assert.match(block, /<output_schema>/);
  assert.match(block, /<\/output_schema>/);
  assert.match(block, /Return ONLY a single JSON object/);
  assert.match(block, /needs-attention/);
  assert.match(block, /line_start/);
  assert.match(block, /confidence/);
  const parsed = embeddedSchema(block);
  assert.deepEqual(parsed.required, ["verdict", "summary", "findings"]);
  assert.deepEqual(parsed.properties.verdict.enum, ["approve", "needs-attention"]);
});

test("buildSchemaBlock falls back to an inline schema when the file is missing", () => {
  const block = buildSchemaBlock("/nonexistent/plugin/root");
  assert.match(block, /<output_schema>/);
  assert.match(block, /needs-attention/);
  assert.match(block, /line_start/);
  const parsed = embeddedSchema(block);
  assert.deepEqual(parsed.required, ["verdict", "summary", "findings"]);
  assert.equal(parsed.properties.findings.items.required.includes("recommendation"), true);
});
