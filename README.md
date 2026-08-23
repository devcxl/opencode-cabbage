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

## Installation

```json
// opencode.json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

Once started, the plugin automatically injects 7 slash commands, 9 flow skills, 6 agents, and 1 goal tool.

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
npm install @devcxl/opencode-cabbage

# 2. Add the plugin to opencode.json
# { "plugin": ["@devcxl/opencode-cabbage"] }

# 3. Run in OpenCode
# /setup → /requirements → @dev-lifecycle
```

## Two Modes

- **Manual mode** — Run each command sequentially for fine-grained control
- **Automatic mode** — Once the requirements are confirmed, enter `@dev-lifecycle` to automatically complete the remaining workflow

## Architecture

```
src/                          # Thin TypeScript layer
├── index.ts                  # Plugin entry point
├── plugin.ts                 # Package root resolution
├── plugin/                   # Loaders + goal tool
│   ├── server.ts             # Main factory: injects skills/commands/agents, goal tool, context, auto-continuation
│   ├── goal.ts               # goal tool (status + goal-verify authorization)
│   ├── commands.ts           # Command loader
│   ├── skills.ts             # Skill loader
│   ├── prompts.ts            # Prompt loader
│   ├── bootstrap.ts          # Startup guidance
│   ├── agents.ts             # Agent injection
│   ├── shell.ts              # Agent shell env isolation
│   └── prompt-lint.ts        # Prompt asset consistency checks
└── kernel/                   # Minimal supporting modules
    ├── context.ts            # root CONTEXT.md discovery/injection
    ├── profile.ts            # AGENTS.md Project Profile parsing
    ├── session-index.ts      # Flow→session index (goal binding + auto-resume)
    ├── permission.ts         # Permission matching semantics
    └── mutex.ts              # Keyed async mutex

assets/                       # Runtime assets (pure Prompt flows)
├── commands/                 # 7 slash commands
├── skills/                   # 9 flow-* skills (Prompt-driven, direct git/gh)
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
