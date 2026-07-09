import { defineConfig } from 'vitepress'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DefaultTheme } from 'vitepress'

function getSidebar(): DefaultTheme.Sidebar {
  const docsDir = join(import.meta.dirname, '..')
  const sidebar: DefaultTheme.Sidebar = {}

  const dirLabels: Record<string, string> = {
    guides: '使用指南',
    adr: '架构决策记录',
    dev: '开发文档',
    prd: '产品需求文档',
  }

  for (const dir of ['guides', 'adr', 'dev', 'prd']) {
    const fullDir = join(docsDir, dir)
    const items: DefaultTheme.SidebarItem[] = []
    const entries = readdirSync(fullDir).sort()
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const fullPath = join(fullDir, entry)
      if (entry.endsWith('.md')) {
        const name = entry.replace('.md', '')
        items.push({
          text: name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          link: `/${dir}/${name}`,
        })
      } else if (statSync(fullPath).isDirectory()) {
        const subEntries = readdirSync(fullPath).sort().filter(e => e.endsWith('.md'))
        if (subEntries.length > 0) {
          items.push({
            text: entry.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            collapsed: dir === 'dev' && entry === 'tasks',
            items: subEntries.map(e => ({
              text: e.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              link: `/${dir}/${entry}/${e.replace('.md', '')}`,
            })),
          })
        }
      }
    }
    if (items.length > 0) {
      sidebar[`/${dir}/`] = [{ text: dirLabels[dir] || dir, items }]
    }
  }

  return sidebar
}

export default defineConfig({
  title: 'opencode-cabbage',
  description: '全流程开发 OpenCode 插件 — 需求→设计→任务→编码→测试→审查→自动合并',
  srcDir: '.',
  outDir: '../.vitepress-dist',
  lastUpdated: true,
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '快速开始', link: '/guides/quickstart' },
      {
        text: '使用指南',
        items: [
          { text: '快速开始', link: '/guides/quickstart' },
          { text: '配置指南', link: '/guides/configuration' },
          { text: '使用指南', link: '/guides/usage' },
          { text: '架构概览', link: '/guides/architecture' },
        ],
      },
      {
        text: '开发',
        items: [
          { text: '贡献指南', link: '/dev/guides/contributing' },
          { text: '技术方案', link: '/dev/specs/opencode-cabbage-docs-and-pages' },
          { text: 'VitePress 迁移', link: '/dev/specs/vitepress-docs-migration' },
          { text: 'Out of Scope', link: '/dev/out-of-scope' },
        ],
      },
      {
        text: 'ADR',
        items: [
          { text: '0001 - 替换 OpenSpec', link: '/adr/0001-replace-openspec-with-full-flow' },
          { text: '0002 - Jekyll 文档站', link: '/adr/2026-07-10-jekyll-github-pages-docs' },
          { text: '0003 - 迁移 VitePress', link: '/adr/2026-07-10-jekyll-to-vitepress' },
        ],
      },
      {
        text: 'PRD',
        items: [
          { text: 'Docs & Pages', link: '/prd/opencode-cabbage-docs-and-pages' },
          { text: 'VitePress 迁移', link: '/prd/vitepress-docs-migration' },
        ],
      },
    ],

    sidebar: getSidebar(),

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            displayDetails: '显示详情',
            noResultsText: '未找到相关结果',
            resetButtonTitle: '清除搜索',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/devcxl/opencode-cabbage' },
    ],

    editLink: {
      pattern: 'https://github.com/devcxl/opencode-cabbage/edit/main/docs/:path',
    },

    lastUpdated: {
      text: '最后更新',
    },

    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
  },
})
