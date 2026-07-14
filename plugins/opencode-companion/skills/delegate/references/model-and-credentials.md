# Model refs and credential rules

## Passing `model`

Pass `model` as `<providerID>/<modelID>`.

- The provider id is the OpenCode **PROVIDER id** from your opencode config — **not**
  the provider *display name* OpenCode's UI may show, and not the grouping shown next
  to the model.
- The modelID often contains slashes itself (e.g. a combo router's
  `group/model-name`), so a full ref like `myprovider/group/model-name` legitimately
  has several slashes — **the split is on the FIRST slash only**.
- If you pass a modelID without its provider prefix and it is unambiguous, the tool
  auto-adds the prefix, and the result's `Model:` line shows what actually ran. If it
  is ambiguous or unknown, the tool returns concrete suggestions.

## How to discover providers and models

**Run `oc_setup` — or `opencode models`. Those are the only two supported ways.**

## Never read credential files

**Never read `~/.local/share/opencode/auth.json` or any other credential/token file
to enumerate providers.**

- It holds **plaintext tokens**.
- Reading it is blocked by the permission layer (correctly).
- It is never necessary: `oc_setup` / `opencode models` already returns the real
  provider and model ids.

## Agent selection

- `agent: "build"` (default): full write access.
- `agent: "plan"`: the **only** read-only mode.
- Choose `plan` only on explicit user intent ("review only", "don't modify
  anything"). An investigative-sounding request ("diagnose", "look into") is not by
  itself read-only — such tasks often precede a fix.
