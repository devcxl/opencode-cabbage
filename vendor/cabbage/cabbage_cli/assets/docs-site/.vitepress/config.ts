import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const base = (process.env.BASE_URL || (process.env.GITHUB_REPOSITORY ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}/` : '/')) as `/${string}/` | '/'

// `cabbage init` creates the whole standard docs tree, so most categories start
// empty. A hardcoded sidebar would link to pages that do not exist yet, so build
// it from the directories that actually have an index page (README.md, which the
// rewrites below map to index.md). Add a README.md to a category and it appears.
const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hasPage = (dir: string) => fs.existsSync(path.join(docsRoot, dir, 'README.md'))

const group = (text: string, entries: [string, string][]) => ({
  text,
  collapsed: false,
  items: entries
    .filter(([dir]) => hasPage(dir))
    .map(([dir, label]) => ({ text: `${label} (${dir})`, link: `/${dir}/` })),
})

const sidebar = [
  group('项目概览', [['00-overview', '概览']]),
  group('规范与设计', [
    ['01-product', '产品需求'],
    ['03-architecture', '系统架构'],
    ['04-domain', '数据设计'],
    ['05-api', 'API 接口'],
  ]),
  group('质量与交付', [
    ['08-testing', '测试计划'],
    ['09-security', '安全评审'],
    ['11-ci-cd', 'CI/CD 流程'],
    ['12-release', '发布计划'],
    ['13-operations', '运维'],
    ['15-incidents', '事故记录'],
  ]),
].filter(section => section.items.length > 0)

const navItems: [string, string][] = [
  ['/', '首页'],
  ['00-overview', '概览'],
  ['01-product', '产品需求'],
  ['03-architecture', '系统架构'],
  ['05-api', 'API 接口'],
  ['08-testing', '测试计划'],
  ['11-ci-cd', 'CI/CD'],
  ['12-release', '发布与变更'],
]

export default withMermaid(
  defineConfig({
    base,
    rewrites: {
      'README.md': 'index.md',
      ':pkg/README.md': ':pkg/index.md',
      ':pkg/:sub/README.md': ':pkg/:sub/index.md',
    },
    lang: 'zh-CN',
    title: 'Project Documentation',
    description: 'Project documentation managed by Cabbage',
    themeConfig: {
      nav: navItems
        .filter(([link]) => link === '/' || hasPage(link))
        .map(([link, text]) => ({ text, link: link === '/' ? '/' : `/${link}/` })),
      sidebar,
      search: {
        provider: 'local',
      },
      footer: {
        message: 'Managed by Cabbage Documentation System',
        copyright: 'Copyright © 2026',
      },
    },
  })
)
