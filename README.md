<div align="center">
  <h1>@devcxl/opencode-cabbage</h1>
  <p>A full-lifecycle development plugin for OpenCode, covering requirements, design, tasks, coding, testing, review, and release with automated orchestration and parallel subagents.</p>
  <p>
    <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage"><img src="https://img.shields.io/npm/v/@devcxl/opencode-cabbage" alt="npm version"></a>
    <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
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

Once started, the plugin automatically injects 7 slash commands, 8 flow skills, 5 agents, and 5 deterministic lifecycle tools.

## Command Overview

| Command | Stage | Output |
|---------|-------|--------|
| `/setup` | Setup | `docs/` directory structure, Project Profile, CI/release workflow validation |
| `/requirements` | Requirements | PRD → `docs/prd/` + Draft Parent Issue |
| `/design` | Design | Technical specification + necessary ADR → `docs/dev/specs/` + `docs/adr/` |
| `/tasks` | Task decomposition | DAG tasks + Sub Issues (GitHub 权威源) |
| `/code` | Coding | Task + Runtime TDD evidence + PR |
| `/review` | Review | Dual-axis review + automatic merge |
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
├── plugin/                   # Loaders + tool factories
│   ├── server.ts             # Main factory: injects skills, commands, agents, 5 lifecycle tools
│   ├── commands.ts           # Command loader
│   ├── skills.ts             # Skill loader
│   ├── prompts.ts            # Prompt loader
│   ├── bootstrap.ts          # Startup guidance
│   ├── agents.ts             # Agent injection
│   ├── setup-control.ts      # setup_control tool
│   ├── flow-control.ts       # flow_control tool
│   ├── task-control.ts       # task_control tool
│   ├── tdd-checkpoint.ts     # tdd_checkpoint tool
│   └── release-control.ts    # release_control tool
└── kernel/                   # Deterministic thin kernel
    ├── slug.ts               # Functional slug derivation/validation
    ├── records.ts            # Flow/Task Record CRUD (GitHub authoritative)
    ├── worktree.ts           # Worktree lifecycle (no --force)
    ├── tdd/                  # Runtime TDD pure functions + evidence
    ├── review.ts             # Merge gates (CI/protection/risk/approval)
    ├── release.ts            # Version proposal + tag immutability
    ├── context.ts            # Root CONTEXT.md discovery/injection
    ├── profile.ts            # AGENTS.md Project Profile parsing
    ├── session-index.ts      # Flow→session index + takeover
    ├── caller.ts             # Caller role matrix
    ├── permission.ts         # Permission matching semantics
    └── legacy.ts             # Legacy FlowRun detection

assets/                       # Runtime assets
├── commands/                 # 7 slash commands
├── skills/                   # 8 flow-* skills
├── agents/                   # 5 agent definitions
└── prompts/                  # Guidance prompts and templates
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
