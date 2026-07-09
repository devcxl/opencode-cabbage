---
title: "E. flow-review 技能更新（changelog + 文档确认）"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/25"
---

## 描述

更新 `assets/skills/flow-review/SKILL.md`，新增文档同步确认步骤和 changelog 追加职责。

## 验收标准

- [ ] flow-review 包含"文档同步确认"步骤（检查 PR body 和 docs/ 变更）
- [ ] 规格审查中包含 changelog 追加子步骤
- [ ] 合并前检查清单包含文档同步和 changelog 确认
- [ ] 步骤编号正确更新

## 实现要点

### 新增步骤 3：文档同步确认

```markdown
### 3. 文档同步确认

确认 PR 中是否包含文档同步：
- 检查 PR body 是否列出已同步的文档
- 检查 `docs/guides/` 和 `docs/dev/guides/` 是否有相应变更
- 如涉及配置/API 变更但文档未同步 → 标记为阻断性问题
```

### 规格轴追加

在规格审查中追加：
```
- 如发现实现与设计偏差 → 追加到 `docs/dev/changelog/<YYYY-MM-DD-NNN-slug>.md`
```

### 合并前检查

在步骤 5（等待 CI）前插入：

```markdown
### 5. 合并前检查

在合并前确认以下项：
- 文档同步已完成（`docs/guides/` 已更新或无需更新）
- changelog 已记录偏差（如有）
- CI 已通过
```
