---
name: "pr2-templates-refs"
depends_on: ["pr1-role-goal"]
labels: ["backend"]
worktree_root: ".worktree/pr2-templates-refs/"
---

## 目标

修复 PRD/ADR 模板断链和 CONTEXT.md 路径错误。

## 实现要点

1. **模板接入**: `setupSkillsDir()` 将 `assets/prompts/` 复制到 `<skillsDir>/_prompts/`
2. **项目级覆盖**: 项目 `.opencode/opencode-cabbage/prompts/*` 优先于内置
3. **Skill 引用修正**: flow-requirements → `_prompts/prd-format`，flow-design → `_prompts/adr-format`、`../_context/CONTEXT.md`
4. **新增测试**: `test/prompts.test.ts` 验证两级加载和引用完整性

## 验收标准

- [ ] `setupSkillsDir()` 产出的 runtime 目录包含 `_prompts/PRD-FORMAT.md` 和 `_prompts/ADR-FORMAT.md`
- [ ] 所有 Skill 中相对路径引用可解析到真实文件
- [ ] 项目级覆盖生效
- [ ] 测试通过

## Worktree
- 路径: `.worktree/pr2-templates-refs/`
- 分支: `feat/pr2-templates-refs`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除
