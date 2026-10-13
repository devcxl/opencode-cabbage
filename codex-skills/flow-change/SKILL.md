---
name: flow-change
description: Maintain a Cabbage change record (tasks + documents) through the built-in `cabbage` tool — create the record, declare risk flags, verify stages, pass gates, sync to docs, archive after merge. Use for bug fixes, refactors, small features, hotfixes, or whenever a tracked record with tasks.md and verification evidence is required in this repository.
---

# flow-change

本仓库的变更记录机制由插件内置的 Cabbage 引擎提供（`cabbage` 工具，无需手工安装）。
一份记录 = 一个目录（`.cabbage/changes/<id>/`）：默认只有一份 `tasks.md`，
高风险时用影响标记展开专项文档；验证通过、合并确认后归档并同步到 `docs/`。

## 何时启用

- 任何需要留痕的代码改动：bug 修复、重构、小功能、紧急修复、业务调整。
- 大流程（requirements/design/code/...）中的具体代码改动：在对应阶段用记录承载
  Goal/Design/Tasks/Verification 与验收证据。
- **不启用**：纯文档小修（直接改归属文档，用 `flow-docs` 约定）、一次性问答、纯调研
  （见 `flow-research`，调研本身不建记录）。

## 默认路径：一次变更一份记录

1. 创建记录（需要项目已初始化；未初始化先 `op:"init"`）：
   - `cabbage({op:"new", type:"change", change:"fix-label"})`
   - 事故复盘用 `type:"incident"`（incident → postmortem → tasks）。
2. 填写 `tasks.md`：`Goal`（含复现的问题）、`Design`（最小方案）、`Tasks`、`Verification`。
3. 实现前评估风险并声明标记（会生成对应专项文档）：
   - `cabbage({op:"impact", change:"fix-label", impact:["api=true","design=true"]})`
   - 标记表：`design`→tech-spec、`rfc`→rfc、`architecture`→adr、`api`→api-design、
     `database`→database-design、`security`→security-review、`deployment`→release-plan。
   - 数据迁移 = `database` + `deployment`；跨团队评审 = `rfc`（+按需 `design`）。
4. 复现失败 → 最小修复 → 回归测试；完成任务清单并写入真实命令与结果。
5. 逐级验证与门禁：
   - `cabbage({op:"verify", change:"fix-label", stage:"tasks"})`（有专项阶段先逐一验证）
   - `cabbage({op:"gate", change:"fix-label", target:"merge"})` → 应输出 ALLOWED。
6. 合并后收尾：确认合并 → `cabbage({op:"archive", change:"fix-label"})`（自动 sync + 归档）。

速查（亮路径全链路）：

```text
cabbage({op:"new", type:"change", change:"fix-label"})
cabbage({op:"impact", change:"fix-label", impact:["api=true"]})   # 仅在确有风险时
cabbage({op:"verify", change:"fix-label", stage:"tasks"})          # 专项阶段先行
cabbage({op:"gate", change:"fix-label", target:"merge"})           # 期望 ALLOWED
cabbage({op:"archive", change:"fix-label"})                        # 确认合并后
```

## 约束

- `change.yaml` 与 `state.json` 由 CLI 管理，不要手工编辑；验证后修改产物会让阶段 `stale`。
- 只声明真实风险；不为省文档隐瞒影响，也不为凑文档虚报标记。
- `archive` 不检查 Git 合并状态：必须人工确认合并后再归档。
- 记录描述单次改动；系统当前行为写入 `docs/` 编号目录（sync 只按映射复制，不做语义合并）。
- CLI 不可用（缺 Python 3.10+）时工具会返回明确错误：告知用户安装 Python，不要伪造验证结果。

## 常用操作

| 操作 | 用途 |
| --- | --- |
| `init` | 初始化 `.cabbage/`（工作流、CI 模板、vendored CLI），每项目一次 |
| `status` / `next` | 记录列表与阶段就绪/阻塞（不猜阶段 ID，以 `next` 为准） |
| `verify` / `gate` | 阶段验证与门禁（`target`：阶段 ID / `merge` / `archive`） |
| `validate` | 结构校验（省略 `change` 校验全部） |
| `sync` / `archive` | 同步当前文档 / 收尾归档 |
| `tasks` / `discard` | 任务清单只读视图 / 废弃记录 |

> 无本插件工具的环境（如 Codex）：以上操作对应 `python3 -m cabbage_cli <操作>` 直跑 CLI
> （CLI 需本地可用），语义与参数一致。

## Contract

### Trigger
由 `@dev-lifecycle` 分诊（Bug 修复、重构、业务调整、紧急修复等轻量路径）或用户要求建立变更记录时触发；
大流程的代码改动也可在实现阶段引用本 skill。

### Inputs
- 变更描述（问题/目标、影响范围）
- 变更 id（kebab-case，按功能派生）
- 可选：影响标记（design/rfc/architecture/api/database/security/deployment）

### Preconditions
- 项目已初始化（无 `.cabbage/` 时先 `init`）
- 插件内置引擎可用（缺 Python 3.10+ 时停止并告知用户）

### Procedure
1. 创建记录并填写 `tasks.md` 的 Goal 与 Design
2. 实现前声明真实风险标记（必要时）
3. 实现并完成 Tasks 清单，记录真实验证命令与结果
4. 逐一 `verify` 已启用阶段（专项在前、`tasks` 在后）
5. `gate merge` 通过后交回编排器提交；合并确认后 `archive`

### Outputs
- `.cabbage/changes/<id>/`：tasks.md 与按需专项文档（验证后签名写入 state.json）
- 归档：`.cabbage/archive/<year>/<id>/` 与 `docs/` 的同步文档

### Failure
- `gate` BLOCKED → 用 `next` 找到未完成的已启用前置阶段并验证
- `placeholder content remains` / `unchecked tasks remain` → 清除模板提示、勾选任务后再验证
- 阶段 `stale` → 对照上游变化重新审阅并重新验证
- CLI 不可用 → 告知用户安装 Python 3.10+，不得伪造记录或验证结果

### Idempotency
- 同名记录已存在 → 复用并更新（`new` 报错说明已存在）
- 重复 `verify` 同一未变化阶段 → 幂等，仅刷新签名时间
- 重复 `sync` → 按映射覆盖目标文档，无副作用

### Prohibited Actions
- 不手工编辑 `change.yaml` / `state.json`
- 不在实现前伪造验证结果（专项文档写待执行步骤，真实结果回填 `tasks.md`）
- 不在未确认合并时 `archive`；不为通过门禁删改 CI 与工作流文件
