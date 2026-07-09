---
name: "创建站点首页和 Jekyll 配置"
depends_on: []
labels: ["docs", "infra"]
---

## 目标

创建 docs/index.md 作为站点首页，配置 Jekyll 站点参数。

## 实现要点

- _config.yml：主题、GFM、相对链接插件
- index.md：命令一览、快速安装、文档链接

## 验收标准

- [x] docs/index.md 已创建
- [x] docs/_config.yml 已创建
- [x] 配置包含主题、markdown、插件
