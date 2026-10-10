import { describe, it, expect, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { detectPython, setupCabbageCli } from "../../src/plugin/cabbage-cli.js"
import { buildCabbageTool } from "../../src/plugin/cabbage-tool.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const vendorRoot = path.join(projectRoot, "vendor/cabbage")
const vendorPkg = path.join(vendorRoot, "cabbage_cli")

/** 与 scripts/sync-cabbage.mjs 相同的树哈希算法：排序 (相对路径, 内容 sha256) 列表的 sha256 */
async function treeHash(root: string): Promise<string> {
  const files: Array<[string, string]> = []
  async function walk(dir: string) {
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

describe("vendored cabbage engine", () => {
  it("matches the recorded MANIFEST tree hash (no hand edits drift)", async () => {
    const manifest = JSON.parse(await readFile(path.join(vendorRoot, "MANIFEST.json"), "utf8")) as { treeHash: string; commit: string; files: number }
    expect(await treeHash(vendorPkg)).toBe(manifest.treeHash)
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.files).toBeGreaterThan(20)
  })

  it("carries the collapsed new-project workflows", async () => {
    const workflows = (await readdir(path.join(vendorPkg, "assets/workflows"))).sort()
    expect(workflows).toEqual(["change.yaml", "incident.yaml"])
  })
})

const python = await detectPython()
const itIfPython = python ? it : it.skip

describe("cabbage CLI runtime", () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  itIfPython("extracts the package into the versioned dir and reports its version", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-cli-test-"))
    process.env.CABBAGE_CLI_DIR = tmpDir
    const cli = await setupCabbageCli(projectRoot, "test-version")
    expect(cli.available, JSON.stringify(cli)).toBe(true)
    expect(cli.version).toMatch(/^\d+\.\d+\.\d+$/)
    const entry = await readFile(path.join(tmpDir, "cli@test-version/cabbage_cli/__main__.py"), "utf8")
    expect(entry).toContain("main()")
  })

  itIfPython("runs the light-path record flow through the tool (init → new → status → gate)", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-cli-flow-"))
    process.env.CABBAGE_CLI_DIR = path.join(tmpDir, "cli-root")
    const cli = await setupCabbageCli(projectRoot, "test-version")
    expect(cli.available).toBe(true)
    const tool = buildCabbageTool(cli, tmpDir)
    const ctx = { sessionID: "sess-1", agent: "dev-lifecycle" }

    const initResult = await tool.execute({ op: "init" }, ctx)
    expect(initResult.content).toContain("initialized cabbage")
    expect(initResult.content).toContain("exit=0")

    const newResult = await tool.execute({ op: "new", type: "change", change: "demo-fix" }, ctx)
    expect(newResult.content).toContain("created demo-fix")
    const tasks = await readFile(path.join(tmpDir, ".cabbage/changes/demo-fix/tasks.md"), "utf8")
    expect(tasks).toContain("# Goal")
    expect(tasks).toContain("# Verification")

    const statusResult = await tool.execute({ op: "status" }, ctx)
    expect(statusResult.content).toContain("demo-fix")

    const gateResult = await tool.execute({ op: "gate", change: "demo-fix", target: "tasks" }, ctx)
    expect(gateResult.content).toContain("ALLOWED")

    const badVerify = await tool.execute({ op: "verify", change: "demo-fix", stage: "tasks" }, ctx)
    expect(badVerify.content).toContain("placeholder")
    expect(badVerify.content).toContain("exit=2")
  })

  it("restricts the tool to the dev-lifecycle orchestrator (double gating)", async () => {
    const cli = { available: false, python: null, dir: null, version: null, reason: "not installed in this test" }
    const tool = buildCabbageTool(cli, "/tmp")
    const denied = await tool.execute({ op: "status" }, { sessionID: "s", agent: "developer" })
    expect(denied.content).toContain("restricted to the dev-lifecycle")
    const unavailable = await tool.execute({ op: "status" }, { sessionID: "s", agent: "dev-lifecycle" })
    expect(unavailable.content).toContain("cabbage CLI unavailable")
  })

  it("reports usage errors for missing arguments instead of running the CLI", async () => {
    const cli = { available: true, python: "python3", dir: "/nonexistent", version: "1.0.0", reason: null }
    const tool = buildCabbageTool(cli, "/tmp")
    const ctx = { sessionID: "s", agent: "dev-lifecycle" }
    expect((await tool.execute({ op: "new" }, ctx)).content).toContain("requires `change`")
    expect((await tool.execute({ op: "verify", change: "x" }, ctx)).content).toContain("requires `stage`")
    expect((await tool.execute({ op: "gate", change: "x" }, ctx)).content).toContain("requires `target`")
    expect((await tool.execute({ op: "impact", change: "x" }, ctx)).content).toContain("non-empty `impact`")
  })
})
