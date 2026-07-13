---
name: setup
description: Check whether OpenCode is installed and its server and providers are ready for delegation from Codex. Use when a delegation fails to connect, before first use, or when the user asks whether OpenCode is set up.
---

# OpenCode Setup Check

Call the `oc_setup` MCP tool and report its output.

- **Installed: No** — the user must install the OpenCode CLI first
  (https://opencode.ai), then configure at least one provider in
  `~/.config/opencode/opencode.jsonc` (any OpenAI-compatible endpoint works:
  a local aggregator, DeepSeek, GLM, Kimi, Doubao, ...).
- **Server Running: No** is usually fine — the companion starts
  `opencode serve` on demand at the first delegation.
- **Providers: none** — delegation will fail; point the user at their
  OpenCode provider configuration. This plugin never stores or edits
  credentials itself.
