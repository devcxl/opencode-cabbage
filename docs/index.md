---
layout: home

hero:
  name: opencode-cabbage
  text: 全流程开发 OpenCode 插件
  tagline: 需求→设计→任务→编码→测试→审查→自动合并
  actions:
    - theme: brand
      text: 快速开始
      link: /guides/quickstart
    - theme: alt
      text: 配置指南
      link: /guides/configuration

features:
  - title: 全流程覆盖
    details: 从需求到发布，9 个 slash command 覆盖完整开发生命周期
    icon: 🔄
  - title: 自动编排
    details: 需求确认后输入 @dev-lifecycle，全自动完成剩余流程
    icon: 🤖
  - title: 并行 Subagent
    details: 编码阶段自动拆分任务并行执行，大幅提升开发效率
    icon: ⚡
  - title: 双轴审查
    details: 规范审查 + 规格审查，确保代码质量与需求一致性
    icon: ✅
---

<p align="center">
  <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage">
    <img src="https://img.shields.io/npm/v/@devcxl/opencode-cabbage" alt="npm version">
  </a>
  <a href="https://github.com/devcxl/opencode-cabbage/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/@devcxl/opencode-cabbage" alt="license">
  </a>
  <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml">
    <img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/pages.yml">
    <img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/pages.yml/badge.svg" alt="GitHub Pages">
  </a>
</p>

## 命令一览

| 命令 | 阶段 | 产出 |
|------|------|------|
| `/setup` | 初始化 | docs/ 目录结构、环境验证 |
| `/requirements` | 需求 | PRD → GitHub Issue |
| `/design` | 设计 | 技术方案 + ADR |
| `/tasks` | 任务拆解 | DAG 任务 + Sub Issues |
| `/code` | 编码 | 分支 + 代码 + PR |
| `/test` | 测试 | CI + 监控 + 汇报 |
| `/review` | 审查 | 双轴审查 + 自动合并 |
| `/release` | ⚠️ 手动 | 版本 → Changelog → Release → npm publish |
| `/handoff` | 交接 | 打包上下文，跨会话传递 |

## 快速安装

```json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

插件启动后自动注入 9 个 slash command、9 个 flow skill、5 个 agent。
