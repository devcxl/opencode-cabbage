# Agent Rules

- Release 流程不得假设 npm 或其他特定技术生态；必须使用项目已确认的 Release Profile 更新版本，并通过项目的 GitHub Actions release workflow 完成实际发布。

## Project Profile

- test command: `npm test -- {testPaths}`
- regression command: `npm test`
- test file patterns: `test/**/*.test.ts`
- implementation file patterns: `src/**/*.ts`
- tdd default mode: strict
- version bump rule: breaking→major, feature→minor, fix→patch
- version file: `package.json $.version`
- tag format: `v{version}`
- release workflow: `.github/workflows/release-publish.yml`

## Agent skills

### Issue tracker

Issue 与 spec 以 GitHub Issues 管理（`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范 triage 标签，字符串与角色同名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

单 context：根 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。
