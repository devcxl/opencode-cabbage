import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { runCabbageOp } from "../../src/cabbage/engine.js"
import { buildCabbageTool } from "../../src/plugin/cabbage-tool.js"

describe("pure TS cabbage engine", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-ts-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function exists(rel: string): Promise<boolean> {
    try {
      await access(path.join(tmpDir, rel))
      return true
    } catch {
      return false
    }
  }

  it("init scaffolds .cabbage/ and unified OpenSpec docs dirs without 18-dir bloat or Python tooling", async () => {
    const res = await runCabbageOp(tmpDir, { op: "init" })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("initialized cabbage")

    expect(await exists(".cabbage/config.yaml")).toBe(true)
    expect(await exists(".cabbage/workflows/change.yaml")).toBe(true)
    expect(await exists(".cabbage/workflows/incident.yaml")).toBe(true)
    expect(await exists("docs/specs")).toBe(true)
    expect(await exists("docs/adr")).toBe(true)
    expect(await exists("docs/prd")).toBe(true)
    expect(await exists("docs/00-overview")).toBe(false)
    expect(await exists(".cabbage/tooling")).toBe(false)
  })

  it("runs light-path change flow: init -> new -> verify fails on placeholder -> fill -> verify -> gate -> archive", async () => {
    await runCabbageOp(tmpDir, { op: "init" })

    const created = await runCabbageOp(tmpDir, { op: "new", type: "change", change: "demo-fix" })
    expect(created.code).toBe(0)
    expect(created.stdout).toContain("created demo-fix")

    const tasksPath = path.join(tmpDir, ".cabbage/changes/demo-fix/tasks.md")
    const rawTasks = await readFile(tasksPath, "utf8")
    expect(rawTasks).toContain("## Goal")
    expect(rawTasks).toContain("## Verification")

    const statusRes = await runCabbageOp(tmpDir, { op: "status" })
    expect(statusRes.code).toBe(0)
    expect(statusRes.stdout).toContain("demo-fix")

    const preGate = await runCabbageOp(tmpDir, { op: "gate", change: "demo-fix", target: "tasks" })
    expect(preGate.code).toBe(0)
    expect(preGate.stdout).toContain("ALLOWED")

    // Placeholder / unchecked box must fail verify with exit=2
    const badVerify = await runCabbageOp(tmpDir, { op: "verify", change: "demo-fix", stage: "tasks" })
    expect(badVerify.code).toBe(2)
    expect(badVerify.stderr).toContain("placeholder")

    // Merge gate must be BLOCKED before tasks is verified
    const blockedGate = await runCabbageOp(tmpDir, { op: "gate", change: "demo-fix", target: "merge" })
    expect(blockedGate.code).toBe(2)
    expect(blockedGate.stdout).toContain("BLOCKED")

    // Fill real content and check task
    const filled = [
      "---",
      "change: demo-fix",
      "cabbage_stage: tasks",
      "---",
      "",
      "# Tasks: demo-fix",
      "",
      "## Goal",
      "Fix label parsing bug.",
      "",
      "## Design",
      "Normalize trimmed labels before matching.",
      "",
      "## Tasks",
      "- [x] Add regression test and fix label trim",
      "",
      "## Verification",
      "`npm test` passed (10/10).",
      "",
    ].join("\n")
    await writeFile(tasksPath, filled, "utf8")

    const okVerify = await runCabbageOp(tmpDir, { op: "verify", change: "demo-fix", stage: "tasks" })
    expect(okVerify.code).toBe(0)

    const allowedMerge = await runCabbageOp(tmpDir, { op: "gate", change: "demo-fix", target: "merge" })
    expect(allowedMerge.code).toBe(0)
    expect(allowedMerge.stdout).toContain("ALLOWED")

    // Editing after verify makes stage stale
    await writeFile(tasksPath, filled + "\nExtra note.\n", "utf8")
    const nextRes = await runCabbageOp(tmpDir, { op: "next", change: "demo-fix" })
    expect(nextRes.stdout).toContain("stale")

    // Re-verify and archive
    expect((await runCabbageOp(tmpDir, { op: "verify", change: "demo-fix", stage: "tasks" })).code).toBe(0)
    const archived = await runCabbageOp(tmpDir, { op: "archive", change: "demo-fix" })
    expect(archived.code).toBe(0)
    expect(await exists(".cabbage/changes/demo-fix")).toBe(false)
    const year = String(new Date().getUTCFullYear())
    expect(await exists(`.cabbage/archive/${year}/demo-fix/tasks.md`)).toBe(true)
  })

  it("supports impact specialist docs, validate checks (mermaid + links), sync to docs/specs, incident, adopt and discard", async () => {
    await runCabbageOp(tmpDir, { op: "init" })
    await runCabbageOp(tmpDir, { op: "new", type: "change", change: "api-update" })

    const impactRes = await runCabbageOp(tmpDir, { op: "impact", change: "api-update", impact: ["api=true", "architecture=true"] })
    expect(impactRes.code).toBe(0)
    expect(await exists(".cabbage/changes/api-update/api-design.md")).toBe(true)
    expect(await exists(".cabbage/changes/api-update/adr.md")).toBe(true)

    // Unclosed mermaid & broken link fail validate
    const apiPath = path.join(tmpDir, ".cabbage/changes/api-update/api-design.md")
    await writeFile(
      apiPath,
      "---\nchange: api-update\ncabbage_stage: api\n---\n\n## Contract\n[bad](./missing.md)\n\n## Compatibility\n```mermaid\nflowchart TD\nA-->B\n",
      "utf8",
    )
    const badVal = await runCabbageOp(tmpDir, { op: "validate", change: "api-update" })
    expect(badVal.code).toBe(2)
    expect(badVal.stderr).toContain("broken local link")
    expect(badVal.stderr).toContain("unclosed Mermaid block")

    // Fix and sync to unified docs/specs & docs/adr
    await writeFile(
      apiPath,
      "---\nchange: api-update\ncabbage_stage: api\n---\n\n## Contract\nGET /v2/health\n\n## Compatibility\nAdditive only.\n",
      "utf8",
    )
    const adrPath = path.join(tmpDir, ".cabbage/changes/api-update/adr.md")
    await writeFile(
      adrPath,
      "---\nchange: api-update\ncabbage_stage: adr\n---\n\n## Context\nNeed v2 endpoint.\n\n## Decision\nAdd /v2/health.\n\n## Consequences\nLow risk.\n",
      "utf8",
    )
    const syncRes = await runCabbageOp(tmpDir, { op: "sync", change: "api-update" })
    expect(syncRes.code).toBe(0)
    expect(await exists("docs/specs/api-update-api.md")).toBe(true)
    expect(await exists("docs/adr/api-update.md")).toBe(true)

    // Incident workflow
    const inc = await runCabbageOp(tmpDir, { op: "new", type: "incident", change: "outage-1" })
    expect(inc.code).toBe(0)
    const incNext = await runCabbageOp(tmpDir, { op: "next", change: "outage-1" })
    expect(incNext.stdout).toContain("incident")
    expect(incNext.stdout).toContain("postmortem")

    // Tasks view & discard
    const tasksView = await runCabbageOp(tmpDir, { op: "tasks", change: "api-update" })
    expect(tasksView.code).toBe(0)
    const discarded = await runCabbageOp(tmpDir, { op: "discard", change: "outage-1" })
    expect(discarded.code).toBe(0)
    expect(await exists(".cabbage/changes/outage-1")).toBe(false)

    // Adopt inventories external markdown
    await mkdir(path.join(tmpDir, "notes"), { recursive: true })
    await writeFile(path.join(tmpDir, "notes/rfc-auth.md"), "# Auth RFC\n", "utf8")
    const adoptRes = await runCabbageOp(tmpDir, { op: "adopt" })
    expect(adoptRes.code).toBe(0)
    expect(await exists(".cabbage/adoption-report.md")).toBe(true)
    const report = await readFile(path.join(tmpDir, ".cabbage/adoption-report.md"), "utf8")
    expect(report).toContain("notes/rfc-auth.md")
  })

  it("buildCabbageTool restricts execution to dev-lifecycle and validates args", async () => {
    const tool = buildCabbageTool(tmpDir)
    const denied = await tool.execute({ op: "status" }, { sessionID: "s", agent: "developer" })
    expect(denied.content).toContain("restricted to the dev-lifecycle")

    const ctx = { sessionID: "s", agent: "dev-lifecycle" }
    expect((await tool.execute({ op: "new" }, ctx)).content).toContain("requires `change`")
    expect((await tool.execute({ op: "verify", change: "x" }, ctx)).content).toContain("requires `stage`")
    expect((await tool.execute({ op: "gate", change: "x" }, ctx)).content).toContain("requires `target`")
    expect((await tool.execute({ op: "impact", change: "x" }, ctx)).content).toContain("non-empty `impact`")

    const initOut = await tool.execute({ op: "init" }, ctx)
    expect(initOut.content).toContain("initialized cabbage")
    expect(initOut.content).toContain("exit=0")
  })
})
