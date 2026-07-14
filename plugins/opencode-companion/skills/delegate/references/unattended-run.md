# The delegated run is UNATTENDED — never let OpenCode ask a question

Nobody is on the other end of a delegation. If the model stops to ask for
clarification, the run hangs until the watchdog kills it, the retry hangs the same
way, and the spend is wasted. A question mid-run is a **prompt bug**, not a user
problem.

## What not to write

Never write task text that invites a question:

- "let me know if…"
- "confirm before proceeding"
- "ask me which approach you prefer"
- "check with me first"

## State the follow-through policy instead

When the request has any ambiguity, append this block verbatim to the task text:

```
This is a non-interactive, unattended run. Nobody can answer a question.
Do not ask for clarification or confirmation — there is no one to reply.
Default to the most reasonable low-risk interpretation and keep going.
If a detail is genuinely undecidable, pick the safest option, proceed, and
record the assumption in your final answer under "Assumptions".
Resolve the task fully before stopping. Do not stop at the first plausible
answer, and do not stop after identifying the issue without applying the fix.
```

## Give it the material to not need a question

Most questions come from missing context. OpenCode sees only the task text plus the
repository — nothing from the Codex conversation. A task text that fully specifies
paths, constraints, and the end state does not produce a question.

Ask for an "Assumptions" / "Open questions" section in the *output* instead of a
mid-run question: if the model genuinely cannot decide something, it should finish
and report it, not block.
