# 技术方案：配置指南与 GitHub Pages 自动部署

## 技术选型

| 选项 | 选择 | 理由 |
|------|------|------|
| 静态站点生成 | Jekyll（GitHub Pages 原生支持） | 零额外运维，push 即部署 |
| 主题 | jekyll-theme-cayman | GitHub Pages 官方支持，简洁适配文档站 |
| 标记语言 | GFM（GitHub Flavored Markdown） | 与 GitHub README 一致，无需学习新语法 |
| 部署平台 | GitHub Pages | 与项目仓库同源，免费 HTTPS |
| 部署触发 | GitHub Actions + pages.yml | 精准控制构建行为，支持 path filter |

## 架构

```
用户 push → main
  └─ path filter: docs/** or README.md
       └─ GitHub Actions: pages.yml
            ├─ actions/configure-pages   (Pages 配置)
            ├─ actions/jekyll-build-pages (Jekyll 构建)
            ├─ actions/upload-pages-artifact (产物上传)
            └─ actions/deploy-pages      (部署到 Pages)
```

## 文档站点结构

```
docs/                     ← Jekyll source
├── _config.yml           ← 站点配置（主题、插件、包含规则）
├── index.md              ← 首页
├── adr/                  ← 架构决策记录
├── dev/guides/           ← 开发指南
└── guides/               ← 用户指南
    ├── quickstart.md
    ├── configuration.md
    ├── usage.md
    └── architecture.md
```

## 与已有 ADR 兼容性检查

- ADR 0001（OpenSpec → 全流程重写）— 兼容。文档目录规范一致，新增 `guides/` 子目录不冲突。

## 关键配置

```yaml
# _config.yml
source: ./docs              # Jekyll 从 docs/ 构建
markdown: GFM               # GitHub Flavored Markdown
plugins:
  - jekyll-relative-links   # 文档间相对链接自动转换
```

```yaml
# .github/workflows/pages.yml
on:
  push:
    branches: [main]
    paths:
      - "docs/**"           # 仅 docs/ 变更触发
      - "README.md"
      - "_config.yml"
```

## 假设与不确定项

- 假设 GitHub Pages 在仓库 Settings 中已配置 Source = GitHub Actions（用户侧操作）
- 站点无自定义域名需求，使用默认 `devcxl.github.io/opencode-cabbage`
