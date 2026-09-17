# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state — `starting`, `active`, `waiting`, `stalled`, or `running`. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/NickSeagull/pi-interactive-subagents
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/) (terminal emulator with built-in multiplexing)

Start pi inside one of them:

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm — no wrapper needed
```

Optional: set `PI_SUBAGENT_MUX=cmux|tmux|zellij|wezterm` to force a specific backend.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Subagent panes are created without stealing keyboard focus (cmux, tmux). Launch commands target child surfaces by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

## Running Inside Paseo

When the parent Pi session is managed by [Paseo](https://paseo.sh), the same
`subagent` tools create native Pi children through Paseo's agent SDK. The
extension selects this backend when `PASEO_AGENT_ID` is present; outside Paseo,
the existing cmux, tmux, zellij, and WezTerm flow remains available.

Native children keep the parent agent as their Paseo parent, so they appear in
the same workspace and their completion, help, interrupt, and resume events
remain visible from Paseo. A child that uses the parent's checkout runs in the
same project directory. Pass `cwd` when the task belongs to another project;
Paseo then resolves that checkout independently while preserving the parent
relationship.

Paseo mode requires a daemon with the Pi provider enabled and the
`@getpaseo/client` 0.8.0 SDK installed by this package. It connects using the
same daemon discovery settings as Paseo: `PASEO_HOST` or `PASEO_LISTEN`, with
`PASEO_HOME` for an alternate daemon directory and `PASEO_PASSWORD` for an
authenticated daemon. A Paseo child is a native managed agent and does not
need a mux backend.

```typescript
// In a Paseo-managed parent, this creates a native Paseo child.
subagent({
  name: "Review API",
  agent: "reviewer",
  task: "Review the current API changes and report the highest-risk issue.",
});

// A child in another project keeps its own checkout and configuration.
subagent({
  name: "Other project",
  cwd: "/work/other-project",
  task: "Run the focused tests in this project and report failures.",
});
```

The call returns immediately. Paseo owns the child process and continues to
deliver its terminal result after a temporary connection loss. Reconnecting or
restarting the parent restores managed children from Paseo; already-delivered
notifications are identified by a durable delivery ID and are acknowledged
without being sent to the parent twice. A disconnect does not terminate the
child. Use the normal controls from either Pi or Paseo:

```typescript
subagent_interrupt({ name: "Review API" });
subagent_resume({ agentId: "<paseo-agent-id>", message: "Please check the error path too." });
```

Paseo-backed children are Pi sessions, so agent definitions, `fork: true`,
`session-mode`, `auto-exit`, `interactive`, tool policies, skills, and the
`caller_ping`/`subagent_done` bootstrap behavior continue to apply. Claude Code
definitions still use the terminal backend and are rejected when a Paseo
parent asks for a native child.

To run the optional live Paseo integration checks, start an isolated test
daemon with a Pi provider enabled and set `PI_TEST_PASEO=1`. The harness
creates its native parent through the SDK and accepts `PASEO_HOST` or
`PI_TEST_PASEO_HOST` for the daemon endpoint. Set `PI_TEST_PASEO_CONTROLS=1`
and `PI_TEST_PASEO_RECONNECT=1` to include the live interrupt and observer
reconnect cases. The default unit suite uses a mocked SDK and does not contact
Paseo.

## Sticky ChatGPT account routing

Pi stores `openai-codex` OAuth credentials in the Pi agent directory selected
by `PI_CODING_AGENT_DIR`. This package supports two independent Pi directories:
one for a personal ChatGPT account and one for a company account. Authenticate
each directory independently with Pi; Codex CLI credentials are not used.

Create the directories and log in with the stock Pi command. Run `/login` in
each session and select the `openai-codex` provider:

```bash
mkdir -m 700 -p ~/.pi/accounts/personal ~/.pi/accounts/company
PI_CODING_AGENT_DIR="$HOME/.pi/accounts/personal" pi
# In Pi: /login, then choose openai-codex.
PI_CODING_AGENT_DIR="$HOME/.pi/accounts/company" pi
# In Pi: /login, then choose openai-codex for the company account.
```

Copy [account-policy.example.json](./account-policy.example.json), replace
the example paths, and keep `personalAgentDir` and `companyAgentDir` as
separate directories. `companyRoots` contains complete directory trees whose
session cwd implies company scope. `sharedConfigDir` is optional and may hold
noncredential resource directories (`extensions`, `skills`, `prompts`, and
`themes`) that can be shared additively.

Launch Pi through the dedicated wrapper so the selected profile is checked
before stock `pi` from `PATH` starts:

```bash
node ./bin/pi-scoped.mjs \
  --config /absolute/path/to/account-policy.json -- \
  --model openai-codex/gpt-5.6-luna
```

The wrapper records the selected scope in the session and passes the canonical
credential directory, policy path, scope, and launcher marker to the child
process. A root started outside `companyRoots` can opt into company scope with
an explicit override:

```bash
node ./bin/pi-scoped.mjs \
  --config /absolute/path/to/account-policy.json --company -- \
  --model openai-codex/gpt-5.6-luna
```

Scope is monotonic. A company parent keeps company scope for children and
descendants, including children whose cwd is an open-source checkout. A
personal parent is upgraded when a child session cwd matches a company root.
On resume, a persisted company marker or the current cwd selects company. The
session cwd is captured for classification; a `cd` inside a shell command does
not change it. The selected account and reason are shown in launcher and agent
diagnostics without displaying credentials.

Use an explicit `.jsonl` Pi session path when relaunching a session. Existing
targets need a valid Pi session header; credential/configuration files and
hard-linked targets are rejected before they can be read or modified:

```bash
node ./bin/pi-scoped.mjs \
  --config /absolute/path/to/account-policy.json \
  --session /absolute/path/to/session.jsonl -- \
  --model openai-codex/gpt-5.6-luna
```

The wrapper rejects ambiguous `--continue`/`--resume`, CLI `--fork`,
`--no-session`, `--api-key`, API-key environment overrides, and non-
`openai-codex` providers. Use the extension-managed fork and resume tools so
scope metadata remains attached to the session. A running personal Pi process
cannot replace its loaded credentials with the company store; relaunch it with
the company override and the explicit session path. If company credentials or
configuration are unavailable, the launch fails clearly and never falls back
to the personal directory.

Paseo does not inherit the calling Pi process's environment. Configure the
stable `pi-personal` and `pi-company` provider aliases from
[paseo.accounts.example.json](./paseo.accounts.example.json). Each alias
extends Paseo's `pi` provider, invokes `pi-scoped.mjs` through an argv-array
command, and sets its profile directory and scope markers explicitly. Paseo's
supported `agent.create` environment handoff then carries those values to the
Pi child even when the daemon has a different ambient environment. The
subagent backend persists the scope, policy, selected directory, and provider
alias in its records and labels for resume and recreation.
Paseo does not persist per-launch environment overrides for recreation; the
stable alias supplies the launcher and scope lower bound again, and the
launcher rechecks the resumed session metadata and cwd.

The profile helper never copies or symlinks `auth.json`, and it does not
overwrite a profile's `settings.json`. OAuth refresh writes therefore remain
inside the selected canonical profile directory. When `sharedConfigDir` is
configured, only the named noncredential resource directories are linked when
the selected profile has no directory at that path; existing profile resources
remain authoritative.
`sharedConfigDir/settings.json` can also initialize a missing profile settings
file once; existing settings are never merged or overwritten.
Pi's `AuthStorage` validates the selected
`openai-codex` OAuth record before a launcher or Paseo child is created. This
repository's fixture tests use synthetic files and never inspect existing
credential contents.

This policy covers the dedicated launcher and the extension's trusted terminal
and Paseo paths. It is protection against accidental account mixing in trusted
workflows, not a security boundary for arbitrary extensions. A direct stock Pi
launch, an unconfigured Paseo provider or daemon API call, and an extension
that creates its own SDK session can bypass it. The generic extension does not
intercept every agent creation. The scope guard verifies the frozen runtime and
reports status, while launcher/profile preflight is the fail-closed boundary;
event-hook exceptions alone are not sufficient. Any future in-process Pi SDK
agent or model call must pass the selected `agentDir`, `authStorage`, and
`modelRegistry` explicitly.

The live Paseo integration suite is opt-in and requires a separately
provisioned test policy, profile, and launcher (`PI_TEST_ACCOUNT_POLICY_FILE`,
`PI_TEST_AGENT_DIR`, and `PI_TEST_SCOPED_LAUNCHER`). It skips when those paths
are absent. Its readiness checks inspect file metadata only; the launched Pi
process performs its normal authentication when a live run is enabled.

## What's Included

### Extensions

**Subagents** — 4 main-session tools + 3 commands, plus 1 subagent-only tool:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagents_list`     | List available agent definitions                                                            |
| `subagent_resume`    | Resume a previous sub-agent session (async)                                                 |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Bundled Agents

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Opus (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Haiku                  | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Sonnet                 | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Opus (medium thinking) | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Sonnet                 | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in mux pane      → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ───────────────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

### In-progress status updates

The widget tracks each Pi-backed sub-agent from a child-written runtime snapshot and labels it with a coarse state:

- `starting` — launched, but no valid child snapshot has been observed yet
- `active` — the child is doing observed runtime work: agent turn, provider request, streaming, or tool execution
- `waiting` — the child finished a turn and is intentionally open for more input or another stage
- `stalled` — the parent has gone too long without a valid current child snapshot and can no longer trust the run is healthy
- `running` — fallback for backends without child snapshots (e.g. Claude)

These labels are no longer derived from session-file growth. Session JSONL is still used for transcript, resume, lineage, and result extraction, but Pi-backed liveness now comes from a small activity snapshot written by the child extension. A fixed internal watchdog marks a run as `stalled` when valid snapshots never appear, stop being readable, or stop matching the current child; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `planner`, or any `/iterate` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and child snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  }
}
```

`config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | —              | Override agent's default model                                                                    |
| `systemPrompt`         | string  | —              | Append to system prompt                                                                           |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately moves the child back to `waiting`, and stale pre-interrupt snapshots are ignored. If the child starts work later, newer snapshots return it to `active`; completion, failure, and `caller_ping` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_resume` parameters:**
- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should auto-exit after its next response. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff.

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                                                                                                                                                                                          |
| `thinking`    | string  | Thinking level: `minimal`, `medium`, `high`                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Auto-shutdown when the agent finishes its turn — no `subagent_done` call needed. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | derived        | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- The session closes after the agent's final message (on the `agent_end` event)
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; agents without `auto-exit` are interactive and stay quiet. Bare spawns with no agent defs (e.g. `/iterate` with `fork: true`) are treated as interactive.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij, wezterm
```

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
