// Test helpers for the OpenCode companion tests.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * Create a temporary directory for test isolation.
 * @param {string} prefix
 * @returns {string}
 */
export function createTmpDir(prefix = "opencode-test") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * Clean up a temporary directory.
 * @param {string} dir
 */
export function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Set up environment for tests.
 * @param {string} tmpDir
 */
export function setupTestEnv(tmpDir) {
  // The Codex frontend's state.mjs honors only OPENCODE_COMPANION_DATA (no
  // CLAUDE_PLUGIN_DATA here) — route all test state into the tmp dir so tests
  // never touch the real ~/.opencode-companion-codex store.
  process.env.OPENCODE_COMPANION_DATA = tmpDir;
  process.env.OPENCODE_COMPANION_SESSION_ID = "test-session-001";
}
