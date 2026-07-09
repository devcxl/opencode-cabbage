---
title: "B. getSidebar() 适配新目录结构"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/25"
---

## 描述

更新 `docs/.vitepress/config.ts` 中 `getSidebar()` 函数，适配新的 `YYYY-MM-DD-NNN-slug/` 嵌套目录结构，并更新导航栏中的 tasks 链接。

## 验收标准

- [ ] `getSidebar()` 能正确遍历 `dev/tasks/` 下的 feature 子目录
- [ ] 侧边栏显示 feature 名称时已剥离日期前缀（如 `2026-07-10-001-vitepress-migration` → `Vitepress Migration`）
- [ ] feature 目录默认折叠（`collapsed: true`）
- [ ] 导航栏中不再硬编码指向具体 task 文件的链接
- [ ] `npm run docs:build` 构建成功

## 依赖

Task A（目录重组）完成后才能执行

## 实现要点

参考技术方案 1.4 节代码：

```ts
if (dir === 'dev' && entry === 'tasks') {
  const featureDirs = readdirSync(fullPath).sort().filter(e => {
    if (e.startsWith('.')) return false
    return statSync(join(fullPath, e)).isDirectory()
  })
  if (featureDirs.length > 0) {
    const taskItems = featureDirs.map(fd => {
      const fdPath = join(fullPath, fd)
      const fdFiles = readdirSync(fdPath).sort().filter(e => e.endsWith('.md'))
      const displayName = fd
        .replace(/^\d{4}-\d{2}-\d{2}-\d{3}-/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
      return {
        text: displayName,
        collapsed: true,
        items: fdFiles.map(f => ({
          text: f.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          link: `/${dir}/${entry}/${fd}/${f.replace('.md', '')}`,
        })),
      }
    })
    items.push({ text: 'Tasks', collapsed: false, items: taskItems })
  }
  continue
}
```

同时移除导航栏配置中的 `/dev/tasks/pages-deployment-workflow` 等硬编码链接。
