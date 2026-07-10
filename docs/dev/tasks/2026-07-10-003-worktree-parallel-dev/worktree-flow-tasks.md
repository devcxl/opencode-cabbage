---
name: "worktree-flow-tasks"
depends_on: []
labels: ["skill"]
worktree_root: ".worktree/worktree-flow-tasks/"
---

## 目标

改造 `assets/skills/flow-tasks/SKILL.md`，使 `/tasks` 阶段创建的 task 文件包含 worktree 声明，为后续 `/code` 阶段自动创建 worktree 提供元数据。

## 实现要点

### 1. task frontmatter 新增 `worktree_root` 字段

在 task 文件模板的 frontmatter 中新增：

```yaml
---
name: "<task-name>"
depends_on: ["<前置任务>"]
labels: ["backend"]
worktree_root: ".worktree/<task-name>/"
---
```

### 2. task body 新增 Worktree 声明

在 task 文件 body 末尾追加：

```markdown
## Worktree

- 路径: `.worktree/<task-name>/`
- 分支: `feat/<task-name>`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除
```

### 3. Sub Issue body 新增 worktree 声明

在 `docs/dev/handoff/task-issue-body.md` 模板中新增：

```markdown
## Worktree
- 路径: `.worktree/<task-name>/`
- 分支: `feat/<task-name>`
```

### 4. 编辑文件

`assets/skills/flow-tasks/SKILL.md` — 更新步骤 2 的 task 文件模板和步骤 3 的 Sub Issue body 模板。

## 验收标准

- [ ] task frontmatter 模板包含 `worktree_root` 字段
- [ ] task body 模板包含 Worktree 声明
- [ ] Sub Issue body 模板包含 worktree 路径和分支信息
- [ ] `/tasks` 执行后，新建的 task 文件自动包含 worktree 元数据

## Worktree

- 路径: `.worktree/worktree-flow-tasks/`
- 分支: `feat/worktree-flow-tasks`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除