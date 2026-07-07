import { mkdir } from "node:fs/promises"
import path from "node:path"
import { pathExists } from "./fs.js"

export const PLUGIN_ID = "opencode-cabbage"

const MAX_SLUG_LENGTH = 60

export function slugify(value: string) {
  let slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-")

  if (slug.length > MAX_SLUG_LENGTH) {
    const sliced = slug.slice(0, MAX_SLUG_LENGTH)
    const lastDash = sliced.lastIndexOf("-")
    slug = lastDash > MAX_SLUG_LENGTH / 2 ? sliced.slice(0, lastDash) : sliced
  }

  return slug || "doc"
}

export function toRelativePath(projectDir: string, targetPath: string) {
  return path.relative(projectDir, targetPath).replace(/\\/g, "/")
}

function docsRoot(projectDir: string) {
  return path.join(projectDir, "docs")
}

export function prdDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "prd")
}

export function adrDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "adr")
}

export function devSpecsDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "dev", "specs")
}

export function devTasksDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "dev", "tasks")
}

export function devApiDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "dev", "api")
}

export function devDbDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "dev", "db")
}

export function devGuidesDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "dev", "guides")
}

export function devHandoffDir(projectDir: string) {
  return path.join(docsRoot(projectDir), "dev", "handoff")
}

export function outOfScopePath(projectDir: string) {
  return path.join(docsRoot(projectDir), "dev", "out-of-scope.md")
}

export function prdPath(projectDir: string, name: string) {
  return path.join(prdDir(projectDir), `${slugify(name)}.md`)
}

export function adrPath(projectDir: string, title: string) {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(adrDir(projectDir), `${date}-${slugify(title)}.md`)
}

export function taskPath(projectDir: string, taskName: string) {
  return path.join(devTasksDir(projectDir), `${slugify(taskName)}.md`)
}

export function pluginTemplateDir(projectDir: string) {
  return path.join(projectDir, ".opencode", PLUGIN_ID, "templates")
}

const DOCS_SUBDIRS = ["prd", "adr", "dev/specs", "dev/tasks", "dev/api", "dev/db", "dev/guides", "dev/handoff"]

export async function ensureDocsStructure(projectDir: string) {
  const created: string[] = []

  for (const sub of DOCS_SUBDIRS) {
    const target = path.join(docsRoot(projectDir), sub)
    if (!(await pathExists(target))) {
      await mkdir(target, { recursive: true })
      created.push(toRelativePath(projectDir, target))
    }
  }

  return created
}
