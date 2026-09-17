# @openclaw/agent-escalation

Gives **OpenClaw** agents two tools for handling uncertainty and unverified
work honestly instead of guessing.

## Tools

### `escalate_to_operator`

Call this when the agent does not have enough information or confidence to
complete a request correctly, and guessing risks a wrong answer.

```json
{
  "reason": "The account lookup returned no match and the request did not name an ID.",
  "attempted": "Searched by email and by display name.",
  "question": "Which account should this be applied to?"
}
```

Returns a structured, loggable record:

```json
{
  "status": "escalated",
  "reason": "...",
  "attempted": "...",
  "question": "..."
}
```

`reason` is required; `attempted` and `question` are optional. The tool has
no external delivery/side effects - it produces a structured result the
agent is instructed to relay to the user, and that a session's logs or
transcript make auditable.

### `verify_task`

Call this before declaring a task done, to report whether its completion
conditions are actually true - not whether they are expected to be.

```json
{
  "taskType": "file_edit",
  "conditions": [
    {
      "description": "file exists with new content",
      "met": true,
      "evidence": "read_file confirmed"
    },
    { "description": "tests pass", "met": false, "evidence": "pnpm test: 2 failed" }
  ]
}
```

If every condition is met, it returns `{ status: "verified", taskType, conditions }`.

If any condition is unmet, it returns `{ status: "unmet", taskType, conditions, repeatCount }`.
The agent is instructed to fix the specific failure and call `verify_task`
again with the same conditions restated. If the **exact same** unmet
conditions come back on a second call in a row for the same session, the
tool auto-builds an `escalate_to_operator`-shaped escalation record and adds
it to the result as `details.escalation` - this happens unconditionally,
independent of whether the agent itself would have chosen to escalate.

Repeat tracking is per-session, keeps only the most recent failing
signature (not full history), and is bounded to 2000 tracked sessions.

#### Deterministic conditions (`checkId`)

A condition can set `checkId` instead of `met`/`evidence`, to have the tool
verify it directly instead of trusting the agent's self-report:

```json
{
  "taskType": "file_edit",
  "conditions": [
    { "description": "workspace has uncommitted changes", "checkId": "git_diff_nonempty" }
  ]
}
```

The tool runs a fixed, built-in check (currently `git_diff_nonempty`: `git
diff --quiet` in the run's `workspaceDir`) and computes `met`/`evidence`
itself from the real exit code. `met`/`evidence` must be omitted when
`checkId` is set - the call is rejected otherwise, so the two verification
modes can't be silently mixed on one condition.

This is deliberately closed for safety: the set of possible checks is a
fixed registry hardcoded in `src/verify-task-tool.ts`, never a command
string or argv the agent supplies. Letting the agent choose what gets
executed here would bypass the repo's own `tools.exec` security tiers
(deny/allowlist/full, sandboxing) - so adding a new check means editing this
plugin's code, not something callers can do from tool input. An exit code
outside the check's expected set throws instead of guessing true/false, and
a missing `workspaceDir` throws instead of running in an arbitrary cwd.

## Why a plugin, not core

Both tools were originally wired directly into core files
(`src/agents/openclaw-tools.ts`, `src/agents/tool-loop-detection.ts`). That
violated this repo's own extension-boundary rule: adding a new capability
should never require unrelated core edits. This plugin uses only the public
`openclaw/plugin-sdk/*` contract (`registerTool`, `readStringParam`,
`AnyAgentTool`, `OpenClawPluginToolContext`) - the same surface a fully
external, separately-published plugin package would use. The only thing
that would change to publish this standalone is the `package.json`
metadata (dependency version instead of `workspace:*`, plus `compat`/`build`
fields) - the tool logic itself is already portable as-is.

## Not included (yet)

The original core version also pointed the loop-detector's critical-level
messages (`unknown_tool_repeat`, `global_circuit_breaker`,
`known_poll_no_progress`, `ping_pong`) at `escalate_to_operator`, and
auto-logged an escalation record the moment a critical loop was detected -
independent of whether this plugin was even installed. That integration
cannot live here without either forking core's loop-detection state, or
this plugin reimplementing its own independent tool-call-loop detector via
`before_tool_call`. Neither is done yet; it is a reasonable follow-up if the
tighter guarantee is wanted later.

## Config

No configuration required.
