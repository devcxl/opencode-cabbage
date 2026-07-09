# 快速开始

5 分钟上手 opencode-cabbage 插件。

## 前置条件

- [OpenCode](https://opencode.ai) 已安装
- Node.js >= 18
- [gh CLI](https://cli.github.com/) 已安装并登录 GitHub
- Git 仓库已创建（本地或远程）

## 第一步：安装插件

```json
// opencode.json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

重启 OpenCode，插件自动加载。

## 第二步：初始化

在对话中执行：

```
/setup
```

插件会：
1. 检测 gh CLI 是否可用
2. 检查 GitHub 远程仓库配置
3. 创建 `docs/` 目录结构

## 第三步：提需求

```
/requirements
```

插件会与你进行需求访谈，生成 PRD 并创建 GitHub Issue。

## 第四步：全自动流程

需求确认后，输入：

```
@dev-lifecycle
```

插件自动完成：设计 → 任务拆解 → 并行编码 → 审查 → 自动合并。

## 下一步

- [配置指南](/guides/configuration) — 了解所有配置选项
- [使用指南](/guides/usage) — 命令详解与最佳实践
- [架构概览](/guides/architecture) — 了解插件工作原理
