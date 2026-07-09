---
title: "D. flow-code 技能更新（文档同步检查）"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/25"
---

## 描述

在 `assets/skills/flow-code/SKILL.md` 中新增"文档同步检查"子步骤，作为编码后 PR 前的固定步骤。

## 验收标准

- [ ] flow-code workflow 包含新的步骤 4：文档同步检查
- [ ] 步骤中包含完整的 checklist 模板（5 个文档）
- [ ] 原步骤 4（更新开发文档）重编号为 5
- [ ] Output 中追加文档同步相关描述

## 实现要点

在步骤 3 和步骤 4 之间插入：

```markdown
### 4. 文档同步检查

完成编码后，逐项检查以下文档是否需要同步更新：

```
## 文档同步检查清单
□ guides/quickstart.md — 安装方式或前置条件有变化吗？
□ guides/configuration.md — 新增/修改了配置项吗？
□ guides/usage.md — 命令或行为有变化吗？
□ guides/architecture.md — 架构或流程有变化吗？
□ docs/dev/guides/contributing.md — 开发流程有变化吗？
```

- 逐项评估，无需修改的跳过
- 需要修改的文档随代码一起提交到同一个 PR
- PR body 中列出已同步的文档
```

原步骤 4 重编号为 5。
