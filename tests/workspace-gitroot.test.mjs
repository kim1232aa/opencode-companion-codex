// resolveWorkspaceArg falls back to git-root detection when no explicit
// workspace is passed, so a call from a subdirectory keys state to the repo
// root instead of splintering per-subdir. An explicit workspace is honored
// verbatim (no git probing).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceArg } from "../plugins/opencode-companion/scripts/oc-companion.mjs";

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

describe("resolveWorkspaceArg — git-root fallback", { skip: !hasGit }, () => {
  it("resolves to the git root when called from a subdirectory with no explicit workspace", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ws-gitroot-"));
    const sub = path.join(repo, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });

    const cwd0 = process.cwd();
    try {
      process.chdir(sub);
      const ws = await resolveWorkspaceArg({});
      // realpath both sides: mkdtemp under /tmp may itself be a symlink.
      assert.equal(fs.realpathSync(ws), fs.realpathSync(repo));
    } finally {
      process.chdir(cwd0);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("honors an explicit workspace arg verbatim (no git probing)", async () => {
    const explicit = path.join(os.tmpdir(), "some", "explicit", "dir");
    assert.equal(await resolveWorkspaceArg({ workspace: explicit }), path.resolve(explicit));
  });
});

describe("resolveWorkspaceArg — non-git fallback", () => {
  it("falls back to the plain cwd when not inside a git repository", async () => {
    // A temp dir that is NOT a git repo (and whose parents aren't either).
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ws-plain-"));
    const cwd0 = process.cwd();
    try {
      process.chdir(plain);
      const ws = await resolveWorkspaceArg({});
      assert.equal(fs.realpathSync(ws), fs.realpathSync(plain));
    } finally {
      process.chdir(cwd0);
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
