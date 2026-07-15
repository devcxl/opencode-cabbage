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

Once started, the plugin automatically injects 9 slash commands, 9 flow skills, and 5 agents.

## Command Overview

| Command | Stage | Output |
|---------|-------|--------|
| `/setup` | Setup | `docs/` directory structure and environment validation |
| `/requirements` | Requirements | PRD → `docs/prd/` + GitHub Issue |
| `/design` | Design | Technical specification + ADR → `docs/dev/specs/` + `docs/adr/` |
| `/tasks` | Task decomposition | DAG tasks + Sub Issues → `docs/dev/tasks/` |
| `/code` | Coding | Branch + code + unit tests + PR |
| `/test` | Testing | Trigger CI + monitor + report |
| `/review` | Review | Dual-axis review + automatic merge |
| `/release` | ⚠️ Manual release | Version → Changelog → Release → npm publish |
| `/handoff` | Handoff | Package context for transfer across sessions |

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
└── plugin/
    ├── server.ts             # Main factory: injects skills, commands, and agents
    ├── commands.ts           # Command loader
    ├── skills.ts             # Skill loader
    ├── prompts.ts            # Prompt loader
    ├── bootstrap.ts          # Startup guidance
    └── agents.ts             # Agent injection

assets/                       # Runtime assets
├── commands/                 # 9 slash commands
├── skills/                   # 9 flow-* skills
├── agents/                   # 5 agent definitions
├── context/                  # Domain glossary
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
