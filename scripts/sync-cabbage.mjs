#!/usr/bin/env node
/**
 * Vendor the Cabbage Python package into this plugin.
 *
 * Usage: node scripts/sync-cabbage.mjs [sourceRepoPath]
 *   sourceRepoPath defaults to $CABBAGE_SOURCE or ../../project-docs-management
 *   (relative to this repository root).
 *
 * Copies <source>/cabbage_cli -> vendor/cabbage/cabbage_cli (excluding
 * __pycache__), then writes vendor/cabbage/MANIFEST.json with the source git
 * commit and a sha256 tree hash. CI checks the tree hash so hand edits to the
 * vendored copy cannot drift silently.
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceRepo = path.resolve(process.argv[2] ?? process.env.CABBAGE_SOURCE ?? path.join(repoRoot, "../../project-docs-management"))
const sourcePkg = path.join(sourceRepo, "cabbage_cli")
const destRoot = path.join(repoRoot, "vendor/cabbage")
const destPkg = path.join(destRoot, "cabbage_cli")

function gitInfo() {
  try {
    const commit = execFileSync("git", ["-C", sourceRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    let branch = null
    try {
      branch = execFileSync("git", ["-C", sourceRepo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()
    } catch {}
    return { commit, branch }
  } catch {
    return { commit: null, branch: null }
  }
}

async function treeHash(root) {
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (!entry.name.endsWith(".pyc")) {
        const rel = path.relative(root, full).split(path.sep).join("/")
        const digest = createHash("sha256").update(await readFile(full)).digest("hex")
        files.push([rel, digest])
      }
    }
  }
  await walk(root)
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash("sha256").update(JSON.stringify(files)).digest("hex")
}

async function main() {
  try {
    const stat = await readFile(path.join(sourcePkg, "core.py"))
    void stat
  } catch {
    console.error(`source package not found: ${sourcePkg}`)
    process.exit(1)
  }

  await rm(destPkg, { recursive: true, force: true })
  await mkdir(destRoot, { recursive: true })
  await cp(sourcePkg, destPkg, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__pycache__") && !src.endsWith(".pyc"),
  })

  const hash = await treeHash(destPkg)
  const files = await countFiles(destPkg)
  const { commit, branch } = gitInfo()
  const manifest = {
    source: "https://github.com/devcxl/cabbage (project-docs-management)",
    branch,
    commit,
    syncedAt: new Date().toISOString(),
    files,
    treeHash: hash,
  }
  await writeFile(path.join(destRoot, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
  console.log(`vendored cabbage_cli: ${files} files, treeHash=${hash.slice(0, 12)}${commit ? `, commit=${commit.slice(0, 12)}` : ""}`)
}

async function countFiles(root) {
  let n = 0
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (!entry.name.endsWith(".pyc")) n += 1
    }
  }
  await walk(root)
  return n
}

await main()
