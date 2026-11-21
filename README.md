<div align="center">
  <h1>@devcxl/opencode-cabbage</h1>
  <p>A full-lifecycle development plugin for OpenCode v2.3+ — fusing OpenSpec living specs with Matt Pocock's engineering workflows, powered by OpenCode's native <code>/goal</code> loop and a zero-dependency TypeScript change engine.</p>
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

**Requires OpenCode v2 (tested on OpenCode v2.3.0 with `@opencode/plugin@^2.3.2`).** Built on the OpenCode v2 `Plugin.define` API, native `opencode.goal` RPC integration, `experimental.idle` background-work awareness, and domain transforms. OpenCode v1 users should stay on the `1.x` release line.

## Installation

```bash
opencode plugin add @devcxl/opencode-cabbage
```

This installs the plugin and registers it in the global OpenCode configuration (`plugins: ["@devcxl/opencode-cabbage"]`). Restart OpenCode or run `opencode reload` to activate.

Once started, the plugin injects 7 `/flow-*` slash commands (prefixed to avoid colliding with OpenCode v2.3 built-in `/review`, `/goal`, `/init`), 12 flow skills, 6 agents, and the pure-TypeScript `cabbage` change-record tool.

- **Native `/goal` integration**: Continuous autonomous execution uses OpenCode's built-in `/goal` (`/goal pause|resume|clear`). Cabbage reads `opencode.goal` RPC state and `experimental.idle` to inject workflow context without running a competing loop.
- **Native `/review` preserved**: OpenCode's built-in `/review` remains available for quick local diff reviews; Cabbage's dual-axis workflow review and PR merge live at `/flow-review`.

## Built-in Change Records (Pure TS Cabbage Engine)

The plugin ships an in-process TypeScript change-record engine (`src/cabbage/`) with **zero Python dependency**, exposed through the `cabbage` tool and `flow-change` skill:

- **Fast-track vs tracked changes**: Small single-task fixes, refactors, and doc edits take the fast track without ceremony. Cross-module or high-risk changes (`api`, `database`, `security`, `deployment`) use `.cabbage/changes/<id>/` with stage verification, merge gates, and OpenSpec semantic sync to `docs/specs/`.
- **Single task ledger**: Feature flows track tasks exclusively in GitHub Parent/Sub Issues—no duplicate local task Markdown or `DAG.md` files.

## Codex Installation (Compatibility Layer)

This package also ships a Codex plugin compatibility layer (`codex-skills/` + `hooks/` + `.codex-plugin/`) so the flow skills and agent prompts work in Codex as well.

```bash
codex plugin marketplace add devcxl/opencode-cabbage
codex plugin list --available
codex plugin add opencode-cabbage@cabbage
```

- **Build artifact included**: the SessionStart hook (`dist/hooks/session-start.js`) ships inside the published npm package.
- **Platform differences**: the Codex layer runs in pure-Prompt mode without OpenCode transforms or slash commands (`@agent-*` skill references).

## Command Overview

| Command | Stage | Output |
|---------|-------|--------|
| `/flow-setup` | Setup | `AGENTS.md` Project Profile, environment readiness |
| `/flow-requirements` | Requirements | PRD → `docs/prd/` + GitHub Parent Issue |
| `/flow-design` | Design | Living Spec + `Testing Decisions` + ADR → `docs/specs/` + `docs/adr/` |
| `/flow-tasks` | Task decomposition | Tracer-bullet Task Plan → GitHub Sub Issues (single task ledger) |
| `/flow-code` | Coding | Worktree + behavior TDD + PR |
| `/flow-review` | Review | Dual-axis review (spec + convention) + PR merge |
| `/flow-release` | ⚠️ Manual release | Version bump → Release PR → tag push → GitHub Actions release |

## Quick Start

```bash
# 1. Install
opencode plugin add @devcxl/opencode-cabbage

# 2. Run in OpenCode
# /flow-setup → /flow-requirements → @dev-lifecycle (optionally with /goal)
```

## Architecture

```
src/                          # Pure TypeScript OpenCode v2.3+ plugin
├── index.ts                  # Default export (Plugin.define)
├── plugin.ts                 # Plugin definition: id + setup wiring
├── cabbage/                  # Zero-dependency TS change-record & OpenSpec validator
│   ├── engine.ts             # init/new/impact/verify/gate/validate/sync/archive/adopt
│   ├── validate.ts           # Markdown headings, placeholders, Mermaid fences, local links
│   └── workflows.ts          # change & incident workflow specs + unified docs mapping
├── plugin/                   # Setup glue + native hooks + built-in tool
│   ├── server.ts             # setup(ctx): transforms, context & experimental.idle hooks
│   ├── builtin-goal.ts       # OpenCode v2.3 opencode.goal RPC reader + idle guard
│   ├── cabbage-tool.ts       # `cabbage` tool (agent-gated to dev-lifecycle)
│   ├── install-dir.ts        # Versioned skills dir install
│   ├── commands.ts           # /flow-* command loader
│   ├── skills.ts             # Skill loader + V2 registration entries
│   ├── prompts.ts            # Prompt loader
│   ├── bootstrap.ts          # Startup guidance
│   ├── agents.ts             # Agent loader + native V2 permissions
│   ├── shell.ts              # Agent shell env isolation
│   └── prompt-lint.ts        # Dev-time prompt asset consistency checks
└── kernel/                   # Supporting modules
    ├── context.ts            # Root CONTEXT.md discovery/injection
    ├── profile.ts            # AGENTS.md Project Profile parsing
    └── permission.ts         # Permission matching semantics

assets/                       # Runtime assets (pure Prompt flows)
├── commands/                 # 7 /flow-* slash commands
├── skills/                   # 12 flow-* skills
├── agents/                   # 6 agent definitions
└── prompts/                  # Guidance prompts

codex-skills/                 # Codex compatibility layer (mirrors assets/, agent-* prefixed)
hooks/                        # Codex SessionStart hook
.codex-plugin/                # Codex plugin manifest
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
