// The shared lib strategy is BYTE-IDENTICAL copies in both sibling repos (a
// shared package would break the plugins' self-contained, zero-dependency
// install story). That only works if drift is loud — this test turns the
// release-time manual diff into a failing test. It SKIPS when the sibling repo
// isn't checked out next to this one (end-user clones), so it gates dev/CI on
// the machine that has both.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MY_LIB = path.join(HERE, "..", "plugins", "opencode-companion", "scripts", "lib");
const SIBLING = process.env.OPENCODE_COMPANION_SIBLING
  ?? path.join(HERE, "..", "..", "opencode-companion-cc");
const SIB_LIB = path.join(SIBLING, "plugins", "opencode", "scripts", "lib");

const hasSibling = fs.existsSync(SIB_LIB);

// Byte-identical set. state.mjs (data-dir strategy) and args.mjs/cli-install.mjs
// (CC-only) are intentionally excluded; prompts.mjs is checked separately.
const SHARED = [
  "opencode-server.mjs", "process.mjs", "render.mjs", "job-control.mjs",
  "tracked-jobs.mjs", "fs.mjs", "git.mjs", "worktree.mjs", "workspace.mjs",
];

describe("shared lib parity with the sibling repo", { skip: !hasSibling }, () => {
  for (const f of SHARED) {
    it(`${f} is byte-identical`, () => {
      const mine = fs.readFileSync(path.join(MY_LIB, f));
      const theirs = fs.readFileSync(path.join(SIB_LIB, f));
      assert.ok(mine.equals(theirs), `${f} has drifted between the repos — re-mirror it (cp) before releasing`);
    });
  }

  it("prompts.mjs differs ONLY in the SAFETY_HEADER block", () => {
    // Blank out the safety-header block — its doc comment plus the definition —
    // (the one sanctioned difference: Claude Code wording vs Codex wording) and
    // require the rest byte-equal.
    const strip = (s) => {
      const mark = s.indexOf(" * Task text is forwarded verbatim");
      const start = s.lastIndexOf("/**", mark);
      const anchor = s.indexOf("const SAFETY_HEADER", mark);
      const close = s.indexOf("].join", anchor);
      const end = s.indexOf("\n", close);
      assert.ok(mark !== -1 && start !== -1 && anchor !== -1 && close !== -1 && end !== -1,
        "safety-header block markers not found (structure changed?)");
      return s.slice(0, start) + "SAFETY_HEADER_BLOCK" + s.slice(end);
    };
    const mine = strip(fs.readFileSync(path.join(MY_LIB, "prompts.mjs"), "utf8"));
    const theirs = strip(fs.readFileSync(path.join(SIB_LIB, "prompts.mjs"), "utf8"));
    assert.equal(mine, theirs, "prompts.mjs drifted OUTSIDE the safety header");
  });
});
