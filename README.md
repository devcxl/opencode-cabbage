<div align="center">
  <h1>@devcxl/opencode-cabbage</h1>
  <p>A full-lifecycle development plugin for OpenCode, covering requirements, design, tasks, coding, testing, review, and release with automated orchestration and parallel subagents.</p>
  <p>
    <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
    <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-draft.yml"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-draft.yml/badge.svg" alt="Release"></a>
    <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-publish.yml"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-publish.yml/badge.svg" alt="Publish to npm"></a>
    <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage"><img src="https://img.shields.io/npm/v/@devcxl/opencode-cabbage" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage"><img src="https://img.shields.io/npm/dm/@devcxl/opencode-cabbage" alt="npm downloads"></a>
    <a href="https://devcxl.github.io/opencode-cabbage"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/pages.yml/badge.svg?branch=main" alt="GitHub Pages"></a>
  </p>
  <p>English | <a href="README.zh.md">简体中文</a></p>
</div>

---

## OpenCode Compatibility

**Requires OpenCode v2 (tested on v2.0.28).** Version 2.0.0 is a V2-only line built on the `@opencode/plugin` 2.x API (`Plugin.define` setup, domain transforms, turn-end-event driven auto-continuation). OpenCode v1 users should stay on the `1.x` release line.

## Installation

```bash
opencode plugin add @devcxl/opencode-cabbage
```

This installs the plugin and registers it in the global OpenCode configuration (`plugins: ["@devcxl/opencode-cabbage"]`). Restart OpenCode or run `opencode reload` to activate.

Once started, the plugin automatically injects 7 slash commands, 12 flow skills, 6 agents, and 2 tools (`goal` for flow state, `cabbage` for change records).

> **⚠️ Plugin conflict — do not combine with other goal plugins.** cabbage ships its own `goal` tool with an auto-continuation loop driven by turn-end events. Installing it together with another goal / auto-continue plugin (e.g. `@prevalentware/opencode-goal-plugin`, `opencode-goal-mode`) risks both loops reacting to the same session activity and injecting continuation prompts: work gets continued twice, continuation counts and token budgets drift out of sync, and abort handling interferes across plugins. Use exactly one goal engine per session — if you rely on an external goal plugin, do not trigger cabbage's goal tool (it is restricted to the `dev-lifecycle` / `goal-verify` agents).

## Built-in change records (Cabbage engine)

The plugin bundles the Cabbage engine (`vendor/cabbage`, version-pinned by `scripts/sync-cabbage.mjs`) and injects a `flow-change` skill plus a `cabbage` tool: create a change record, declare risk flags, verify stages, pass gates, sync current-state docs, and archive after merge. A record is one directory under `.cabbage/changes/<id>/` — a single `tasks.md` by default; specialist documents (`design` / `rfc` / `adr` / `api` / `database` / `security` / `release`) open only for declared risks.

- **Requirements**: Python 3.10+ on the machine. The CLI is released per plugin version to `~/.config/opencode/cabbage/cli@<version>/`; without Python the tool returns a readable error and everything else keeps working.
- **Bootstrap a project**: `cabbage({op:"init"})` scaffolds `.cabbage/`, the docs skeleton, the CI template, and a vendored CLI copy for GitHub Actions. Existing docs: `cabbage({op:"adopt"})` inventories markdown outside the docs tree (moves stay manual).
- **Light path**: `new` → fill `tasks.md` → `verify` → `gate merge` → `archive` after the merge is confirmed. The tool is restricted to the `dev-lifecycle` orchestrator.

## Codex Installation (Compatibility Layer)

This package also ships a Codex plugin compatibility layer (`codex-skills/` + `hooks/` + `.codex-plugin/`) so the flow skills and agent prompts work in Codex as well.

The repository is a Codex marketplace: add it as a marketplace source, then install the plugin from it.

```bash
# 1. Add this repository as a Codex marketplace
codex plugin marketplace add devcxl/opencode-cabbage

# 2. Confirm the plugin is available
codex plugin list --available

# 3. Install the plugin (pulled from the npm package, which bundles all Codex files)
codex plugin add opencode-cabbage@cabbage
```

Notes:

- **Build artifact included**: the SessionStart hook (`dist/hooks/session-start.js`) ships inside the published npm package — no local build required.
- **Hook trust review**: Codex requires interactive trust approval for hooks (`/hooks` command) on first run — approve the `SessionStart` hook to enable context injection.
- **Marketplace name**: the marketplace is named `cabbage` (see `.agents/plugins/marketplace.json`); use `opencode-cabbage@cabbage` as the plugin selector.
- **Platform differences**: the Codex layer is a pure-Prompt downgrade — no `goal` tool, no slash commands, no automatic continuation. Agents are plain skills (referenced as `@agent-*`), and flow state is tracked via GitHub Issue checklists. See `codex-skills/agent-dev-lifecycle/SKILL.md` for details.

## Command Overview

| Command | Stage | Output |
|---------|-------|--------|
| `/setup` | Setup | `docs/` directory structure, Project Profile, CI/release workflow validation |
| `/requirements` | Requirements | PRD → `docs/prd/` + Draft Parent Issue |
| `/design` | Design | Technical specification + necessary ADR → `docs/dev/specs/` + `docs/adr/` |
| `/tasks` | Task decomposition | DAG tasks + Sub Issues (GitHub 权威源) |
| `/code` | Coding | Task + PR (TDD enforced by CI) |
| `/review` | Review | Dual-axis review + merge |
| `/release` | ⚠️ Manual release | Version proposal → Release PR → tag push → workflow monitor |

## Quick Start

```bash
# 1. Install
opencode plugin add @devcxl/opencode-cabbage

# 2. Run in OpenCode
# /setup → /requirements → @dev-lifecycle
```

## Two Modes

- **Manual mode** — Run each command sequentially for fine-grained control
- **Automatic mode** — Once the requirements are confirmed, enter `@dev-lifecycle` to automatically complete the remaining workflow

## Architecture

```
src/                          # Thin TypeScript layer (OpenCode V2 plugin)
├── index.ts                  # Default export (Plugin.define)
├── plugin.ts                 # Plugin definition: id + setup wiring
├── plugin/                   # Setup glue + built-in tools
│   ├── server.ts             # setup(ctx): domain transforms (skills/commands/agents/tools), hooks, event dispatch
│   ├── continuation.ts       # Turn-end driven continuation + auto-resume + child-session activity tracker
│   ├── goal.ts               # goal tool (status machine + goal-verify authorization)
│   ├── goal-store.ts         # Goal persistence (session metadata)
│   ├── cabbage-cli.ts        # Releases the bundled Cabbage engine per plugin version; python detection + exec
│   ├── cabbage-tool.ts       # `cabbage` tool: change records (ops mapped to the bundled CLI, agent-gated)
│   ├── install-dir.ts        # Versioned dir install (lock + completeness check; shared by skills and the engine)
│   ├── session-abort.ts      # User-interrupt markers (shared by events/tool/continuation)
│   ├── commands.ts           # Command loader (execute-style registration)
│   ├── skills.ts             # Skill loader + V2 registration entries
│   ├── prompts.ts            # Prompt loader
│   ├── bootstrap.ts          # Startup guidance
│   ├── agents.ts             # Agent loader + V1→V2 permission/tools rule conversion
│   ├── shell.ts              # Agent shell env isolation
│   └── prompt-lint.ts        # Prompt asset consistency checks
└── kernel/                   # Minimal supporting modules
    ├── context.ts            # root CONTEXT.md discovery/injection
    ├── profile.ts            # AGENTS.md Project Profile parsing
    ├── session-index.ts      # Flow→session index (goal binding + auto-resume)
    ├── permission.ts         # Permission matching semantics
    └── mutex.ts              # Keyed async mutex

vendor/cabbage/               # Bundled Cabbage engine (synced via scripts/sync-cabbage.mjs; hash-pinned)

assets/                       # Runtime assets (pure Prompt flows)
├── commands/                 # 7 slash commands
├── skills/                   # 12 flow-* skills (Prompt-driven, direct git/gh)
├── agents/                   # 6 agent definitions
└── prompts/                  # Guidance prompts and templates

codex-skills/                 # Codex compatibility layer (mirrors assets/, agent-* prefixed)
hooks/                        # Codex SessionStart hook (hooks.json + compiled dist/hooks/)
.codex-plugin/                # Codex plugin manifest (plugin.json)
```

## Documentation

| Document | Link |
|----------|------|
| Quick Start | [docs/guides/quickstart.md](docs/guides/quickstart.md) |
| Configuration Guide | [docs/guides/configuration.md](docs/guides/configuration.md) |
| Usage Guide | [docs/guides/usage.md](docs/guides/usage.md) |
| Architecture Overview | [docs/guides/architecture.md](docs/guides/architecture.md) |
| Contributing Guide | [docs/dev/guides/contributing.md](docs/dev/guides/contributing.md) |

## License

MIT
