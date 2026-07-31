# 开发指南

## 项目结构

```
src/           TypeScript 源码（薄基础设施层）
assets/        运行时资源（skills/commands/agents/prompts）
docs/          项目文档
```

## 构建

```bash
npm run build        # tsc 编译
npm run typecheck    # 类型检查
```

## 添加新命令

1. 创建 `assets/commands/<name>.md`（frontmatter + 模板内容）
2. 创建 `assets/skills/flow-<name>/SKILL.md`（技能定义）
3. 构建验证

插件重启后自动加载新命令和 skill。

## 添加新 Agent

1. 创建 `assets/agents/<name>.md`（frontmatter: name/mode/color/description + body = prompt）
2. 或放入 `assets/agents/team/` 作为 subagent
3. `src/plugin/agents.ts` 自动扫描并注入到 config

## 发布

发布走项目自身的 Release 流程：按 Profile 的版本规则更新版本文件 → 创建 Release PR → 人工批准合并 → 打 tag push → 由 `.github/workflows/release-publish.yml`（或项目配置的 release workflow）自动发布。不直接手动 `npm publish`。
