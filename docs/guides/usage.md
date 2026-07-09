# 使用指南

本文档详细介绍 opencode-cabbage 插件所有命令和模式的用法。

---

## 两种工作模式

### 手动模式

按顺序逐一执行命令，适合需要精细控制的场景：

```
/setup → /requirements → /design → /tasks → /code → /test → /review → /release
```

### 自动模式

需求确认后，输入 `@dev-lifecycle` 即可全自动完成剩余流程（终点为自动合并，不包含 release）。

---

## 命令详解

### `/setup` — 初始化

**用途**：首次使用前的环境准备。

**检测项**：
- gh CLI 是否安装并可执行
- GitHub 远程仓库是否配置
- 是否需要 GitHub CLI 认证

**产出**：
- `docs/prd/`、`docs/adr/`、`docs/dev/{specs,tasks,api,db,guides,handoff}/` 目录

**何时执行**：第一次使用插件时，或切换到一个新项目时。

---

### `/requirements` — 需求分析

**用途**：将模糊需求转化为结构化 PRD。

**流程**：
1. **需求访谈** — AI 会追问需求细节，澄清范围
2. **PRD 输出** → `docs/prd/<title>.md`
3. **创建 GitHub Issue** — 作为 Parent Issue，后续 Sub Issues 以此为锚点

**产出**：
- `docs/prd/<title>.md` — 产品需求文档
- GitHub Issue #N — 需求跟踪 Issue

**PRD 结构**：
- 背景与动机
- 目标
- 范围（In Scope / Out of Scope）
- 用户故事
- 验收标准
- 技术约束
- Open Questions

---

### `/design` — 技术设计

**用途**：基于 PRD 输出技术方案和架构决策。

**流程**：
1. 委派 `@architect` 阅读 PRD
2. 输出技术方案 → `docs/dev/specs/<title>.md`
3. 记录关键 ADR → `docs/adr/<date>-<slug>.md`
4. 在 Parent Issue 发布评论

**产出**：
- `docs/dev/specs/<title>.md` — 完整技术方案（技术栈、架构、模块、接口、数据模型）
- `docs/adr/<date>-<slug>.md` — 架构决策记录
- Issue comment — 方案摘要

**ADR 结构**：
- 标题、状态、日期
- 背景
- 决策
- 备选方案（含未采纳原因）
- 后果（正面 + 负面）

---

### `/tasks` — 任务拆解

**用途**：将技术方案拆解为 DAG 任务并创建 Sub Issues。

**流程**：
1. 委派 `@architect` 分析技术方案
2. 拆解为独立可执行的任务，标注依赖关系
3. 每个任务创建 task markdown 文件 → `docs/dev/tasks/<task-name>.md`
4. 为每个任务创建 GitHub Sub Issue，关联 Parent Issue

**任务定义格式**（frontmatter）：

```yaml
---
name: 实现用户注册接口
dependsOn: []           # 依赖的任务 ID
area: backend           # backend | frontend | common
parallelSafe: true      # 是否可以与其他任务并行
expectedFiles:
  - src/controllers/AuthController.ts
  - src/services/AuthService.ts
  - src/repositories/UserRepository.ts
testCommands:
  - npm run test:auth
acceptance: 用户可以通过邮箱+密码注册，收到验证邮件
---
```

**DAG 原则**：
- 每个任务应是垂直切片，单人 2-4 小时可完成
- 无依赖的任务可以并行执行
- 有依赖的任务按拓扑排序逐 batch 处理

---

### `/code` — 编码实现

**用途**：按 DAG 拓扑排序，逐 batch 实现代码。

**流程**：
1. 按拓扑排序获取 ready 任务
2. 为每个任务创建分支 `feat/<task-slug>`
3. 并行派发 `@backend` / `@frontend` 实现代码 + 单测
4. 创建 PR
5. 委派 `@reviewer` 审查 PR
6. CI 通过后自动合并

**实现规范**：
- 后端：Controller → Service → Repository 逐层实现
- 前端：组件 → 页面 → 路由 → 接口对接
- TDD 优先：先写测试 → 最小实现 → 重构
- Conventional Commits，多次提交

**禁止事项**：
- 不创建与任务无关的文件
- 不引入未在项目中使用的第三方依赖
- 不提交硬编码的密钥/配置

---

### `/test` — CI 测试

**用途**：触发 CI 流水线并监控结果。

**流程**：
1. 在已创建的 PR 上触发 CI
2. 监控 CI 运行状态
3. 汇报测试结果

**监控内容**：
- CI 队列长度（背压检测）
- CI 运行状态
- 测试通过/失败情况

---

### `/review` — 代码审查

**用途**：AI 双轴审查 PR 并自动合并。

**流程**：
1. 委派 `@reviewer` 获取 PR diff
2. 双轴审查：
   - **规范轴** — 代码是否符合编码标准？
   - **规格轴** — 代码是否忠实实现了 PRD/技术方案？
3. 输出审查报告
4. 根据结果 Approve 或 Request Changes

**审查报告格式**：

```
[CRITICAL] 标题 - 必须修复
- 文件:path:行号
- 问题描述
- 修复建议

[HIGH] 标题 - 应该修复
[MEDIUM] 标题 - 建议修复
```

**合并条件**：
- 无 Critical/High 问题 → Approve + 自动合并
- 有 Critical/High → Request Changes + 修复后重审（最多 9 轮）

---

### `/release` — 发布（手动阶段）

**⚠️ 该阶段为手动触发**，不会在自动模式中执行。

**流程**：
1. 版本号更新（`npm version patch|minor|major`）
2. 生成 Changelog
3. 创建 GitHub Release
4. npm publish

---

### `/handoff` — 上下文交接

**用途**：当上下文窗口压力过大或需要跨会话传递进度时使用。

**流程**：
1. 打包当前 FlowRun 状态
2. 输出到 `docs/dev/handoff/`
3. 下次会话可读取恢复

---

## 自动编排（@dev-lifecycle）

### 启动方式

需求确认后，直接输入：

```
@dev-lifecycle
```

### 执行流程

```
Phase 1: 技术方案 + ADR         (委派 @architect)
Phase 2: DAG 任务拆解 + Sub Issues (委派 @architect)
Phase 3: 并行编码实现              (委派 @backend / @frontend / @reviewer)
Phase 4: 合并确认
Complete: goal 验证 + 完成
```

### 异常处理

| 场景 | 处理 |
|------|------|
| 步骤失败 | Pause flow，通知用户 |
| 审查不通过 | 修复→重审，最多 9 轮 |
| Continuation 耗尽 | Pause，用户介入 |
| 子 agent 错误 | 自动重试 3 次 → 跳过 2 次 → Pause |

### Goal 状态管理

Flow 状态通过 `goal` tool 管理：

- `goal({op:"create", objective, completion_criterion})` — 开始 flow
- `goal({op:"get"})` — 查看当前 flow 状态
- `goal({op:"pause"})` — 暂停 flow
- `goal({op:"resume"})` — 恢复 flow
- `goal({op:"cancel"})` — 取消 flow
- `goal({op:"complete"})` — 完成 flow（需 goal-verify 子 agent 调用）

> 只有 `@goal-verify` 子 agent 可以调用 `goal({op:"complete"})`，主 agent 调用会被 BLOCKED。

---

## 最佳实践

### 什么时候用手动模式

- 需求还不明确，需要多轮访谈
- 需要精细控制每一步的产出
- 部分阶段需要人工参与（如设计评审）

### 什么时候用自动模式

- 需求已清晰确认
- 标准功能开发
- 希望最大化效率

### 文档规范

- PRD → `docs/prd/`
- ADR → `docs/adr/`
- 技术方案 → `docs/dev/specs/`
- 任务定义 → `docs/dev/tasks/`
- 开发文档 → `docs/dev/{api,db,guides}/`

### 分支命名

```
feat/<task-slug>
```

### 提交规范

使用 Conventional Commits：

```
feat: 新增用户注册接口
fix: 修复登录超时问题
refactor: 重构权限校验逻辑
docs: 更新 API 文档
test: 添加用户模块单元测试
```

### 版本发布

```bash
npm version patch  # bugfix
npm version minor  # 新功能（向后兼容）
npm version major  # 破坏性变更
git push origin main --tags
npm publish
```
