import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withWorktree } from "../plugins/opencode-companion/scripts/lib/worktree.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

describe("withWorktree", { skip: !hasGit }, () => {
  let repo;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "init"]);
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("runs fn in an isolated worktree and applies its changes back", async () => {
    const logs = [];
    const result = await withWorktree(
      { dir: repo, jobId: "job-apply", useWorktree: true, isWrite: true },
      async (cwd) => {
        assert.notEqual(cwd, repo, "should run inside a worktree, not the live repo");
        assert.ok(cwd.includes(".opencode-worktrees"), cwd);
        fs.writeFileSync(path.join(cwd, "created.txt"), "hello\n");
        fs.writeFileSync(path.join(cwd, "base.txt"), "base modified\n");
        return "ok";
      },
      (m) => logs.push(m)
    );

    assert.equal(result, "ok");
    // Changes applied back to the live repo working tree.
    assert.equal(fs.readFileSync(path.join(repo, "created.txt"), "utf8"), "hello\n");
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "base modified\n");
    // Worktree cleaned up — child dir and the now-empty parent both gone.
    assert.ok(!fs.existsSync(path.join(repo, ".opencode-worktrees", "job-apply")));
    assert.ok(!fs.existsSync(path.join(repo, ".opencode-worktrees")));
    assert.ok(logs.some((l) => /applied/i.test(l)), logs.join(" | "));
  });

  it("runs in the matching SUBDIR inside the worktree when dir is a repo subdir", async () => {
    const sub = path.join(repo, "pkg", "inner");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "keep.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add sub"]);

    let seenCwd = null;
    await withWorktree(
      { dir: sub, jobId: "job-sub", useWorktree: true, isWrite: true },
      async (cwd) => {
        seenCwd = cwd;
        // cwd must be the worktree's copy of pkg/inner, not the worktree root.
        assert.ok(cwd.includes(path.join(".opencode-worktrees", "job-sub", "pkg", "inner")), cwd);
        fs.writeFileSync(path.join(cwd, "made.txt"), "sub\n");
      }
    );
    assert.ok(seenCwd.endsWith(path.join("pkg", "inner")), seenCwd);
    // Change applied back to the real subdir.
    assert.equal(fs.readFileSync(path.join(sub, "made.txt"), "utf8"), "sub\n");
    assert.ok(!fs.existsSync(path.join(repo, ".opencode-worktrees")));
  });

  it("runs directly in the repo when isolation is not requested", async () => {
    let seen = null;
    await withWorktree(
      { dir: repo, jobId: "job-noop", useWorktree: false, isWrite: true },
      async (cwd) => {
        seen = cwd;
      }
    );
    assert.equal(seen, repo);
  });

  it("falls back to the live repo when dir is not a git repository", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "wt-plain-"));
    try {
      let seen = null;
      const logs = [];
      await withWorktree(
        { dir: plain, jobId: "job-nogit", useWorktree: true, isWrite: true },
        async (cwd) => {
          seen = cwd;
        },
        (m) => logs.push(m)
      );
      assert.equal(seen, plain);
      assert.ok(logs.some((l) => /not inside a git repository/i.test(l)));
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("captures a commit made inside the worktree and applies it back", async () => {
    // Regression: writeback diffed against the literal "HEAD" ref, so if the
    // agent ran `git commit`, HEAD moved to that commit and the diff came back
    // EMPTY — the committed work was silently dropped when the worktree was
    // removed. The diff is now pinned to the base SHA captured at creation.
    const logs = [];
    const result = await withWorktree(
      { dir: repo, jobId: "job-commit", useWorktree: true, isWrite: true },
      async (cwd) => {
        fs.writeFileSync(path.join(cwd, "committed.txt"), "from a commit\n");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-qm", "agent commit inside worktree"]);
        return "ok";
      },
      (m) => logs.push(m)
    );
    assert.equal(result, "ok");
    // The committed file must land in the live repo working tree.
    assert.equal(fs.readFileSync(path.join(repo, "committed.txt"), "utf8"), "from a commit\n");
    assert.ok(logs.some((l) => /applied/i.test(l)), logs.join(" | "));
    assert.ok(!fs.existsSync(path.join(repo, ".opencode-worktrees")));
  });

  it("throws instead of reporting success when changes cannot be applied back", async () => {
    // Regression: an apply conflict (or an oversized patch) used to be logged and
    // then `return result` — reporting the task COMPLETE while its changes sat
    // stranded in the worktree. It now throws so the job fails honestly, and the
    // worktree is preserved for recovery.
    const wtRoot = path.join(repo, ".opencode-worktrees", "job-conflict");
    await assert.rejects(
      withWorktree(
        { dir: repo, jobId: "job-conflict", useWorktree: true, isWrite: true },
        async (cwd) => {
          fs.writeFileSync(path.join(cwd, "conflict.txt"), "worktree content\n");
          // The SAME new file already exists in the live repo with different
          // content, so the "add file" patch cannot apply back cleanly.
          fs.writeFileSync(path.join(repo, "conflict.txt"), "pre-existing live content\n");
          return "ok";
        }
      ),
      /could NOT be applied back|conflict/i
    );
    // The worktree is preserved so the stranded work can be recovered.
    assert.ok(fs.existsSync(wtRoot), "worktree must be kept for recovery on a failed writeback");
  });
});
