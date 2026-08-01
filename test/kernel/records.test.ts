import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import {
  EVIDENCE_MARKER_START,
  EVIDENCE_MARKER_END,
  buildEvidenceCommentBody,
  extractEvidenceBlock,
  createFlowRecord,
  readFlowRecord,
  updateFlowRecord,
  createTaskRecord,
  readTddEvidenceComment,
  appendTddEvidence,
  setStageLabel,
  MAX_EVIDENCE_COMMENT_BYTES,
} from "../../src/kernel/records.js"
import type { setRecordsGhExecutor as SetRecordsGhExecutorType } from "../../src/kernel/records.js"

type GhFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let setRecordsGhExecutor: typeof SetRecordsGhExecutorType

beforeAll(async () => {
  const mod = await import("../../src/kernel/records.js")
  setRecordsGhExecutor = mod.setRecordsGhExecutor
})

beforeEach(() => {
  setRecordsGhExecutor(() => {
    throw new Error("unexpected gh call")
  })
})

afterEach(() => {
  setRecordsGhExecutor(null)
})

describe("createFlowRecord", () => {
  it("creates the parent issue with flow label and returns the ref (gh 2.96: no --draft/--json)", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("label create")) return { stdout: "", stderr: "" }
      return { stdout: "https://github.com/devcxl/opencode-cabbage/issues/42", stderr: "" }
    })

    const result = await createFlowRecord({ slug: "validate-execution-binding", body: "## Goal\n..." })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ref).toEqual({ parentIssueNumber: 42, slug: "validate-execution-binding" })
    }
    expect(calls.some(c => c.includes("label create 'cabbage:flow' --force"))).toBe(true)
    const createCall = calls.find(c => c.includes("issue create"))
    expect(createCall).toBeDefined()
    if (createCall) {
      expect(createCall).toContain("--label 'cabbage:flow'")
      expect(createCall).not.toContain("--draft")
      expect(createCall).not.toContain("--json")
    }
  })

  it("autoMode adds the cabbage:auto label on creation", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("label create")) return { stdout: "", stderr: "" }
      return { stdout: "https://github.com/devcxl/opencode-cabbage/issues/43", stderr: "" }
    })

    const result = await createFlowRecord({ slug: "full-auto-flow", body: "b", autoMode: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.parentIssueNumber).toBe(43)
    const createCall = calls.find(c => c.includes("issue create"))
    expect(createCall).toBeDefined()
    if (createCall) {
      expect(createCall).toContain("--label 'cabbage:flow' --label 'cabbage:auto'")
    }
    expect(calls.some(c => c.includes("label create 'cabbage:auto' --force"))).toBe(true)
  })

  it("returns error when gh fails", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("gh auth failed")
    })
    const result = await createFlowRecord({ slug: "x", body: "b" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("gh auth failed")
    }
  })
})

describe("readFlowRecord", () => {
  it("reads the issue body", async () => {
    setRecordsGhExecutor(async () => ({ stdout: "## Goal\nsome body", stderr: "" }))
    const result = await readFlowRecord(42)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body).toBe("## Goal\nsome body")
    }
  })

  it("returns NOT_FOUND when issue is missing", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("GraphQL: Could not resolve to an Issue")
    })
    const result = await readFlowRecord(999)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND")
    }
  })
})

describe("updateFlowRecord", () => {
  it("writes the new body when previousBody matches the current body", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("issue view")) return { stdout: "current body", stderr: "" }
      return { stdout: "", stderr: "" }
    })

    const result = await updateFlowRecord(42, "current body", (current) => `${current}\n\nupdated`)
    expect(result).toEqual({ ok: true, retried: false })
    const editCall = calls.find(c => c.startsWith("issue edit"))
    expect(editCall).toBeDefined()
    if (editCall) {
      expect(editCall).toContain("current body")
      expect(editCall).toContain("updated")
    }
  })

  it("retries once against the latest body when previousBody is stale", async () => {
    const calls: string[] = []
    let readCount = 0
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("issue view")) {
        readCount += 1
        // 第一次读返回过期 body 之外的版本，模拟外部并发修改
        return { stdout: readCount === 1 ? "external change" : "latest body", stderr: "" }
      }
      return { stdout: "", stderr: "" }
    })

    const result = await updateFlowRecord(42, "my previous body", (current) => `${current}+new`)
    expect(result).toEqual({ ok: true, retried: true })
    const editCall = calls.find(c => c.startsWith("issue edit"))
    expect(editCall).toBeDefined()
    if (editCall) {
      expect(editCall).toContain("latest body+new")
    }
  })

  it("returns error when gh fails", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("boom")
    })
    const result = await updateFlowRecord(42, "b", (c) => c)
    expect(result.ok).toBe(false)
  })
})

describe("createTaskRecord", () => {
  it("creates a sub issue linked to the parent and returns the ref (gh 2.96: no --json)", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      return { stdout: "https://github.com/devcxl/opencode-cabbage/issues/77", stderr: "" }
    })

    const result = await createTaskRecord({
      title: "flow-record-layer",
      body: "## Acceptance\n- [ ] a",
      parentIssueNumber: 42,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ref).toEqual({
        parentIssueNumber: 42,
        taskId: "flow-record-layer",
        issueNumber: 77,
      })
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("issue create")
    expect(calls[0]).toContain("--parent 42")
    expect(calls[0]).not.toContain("--json")
  })

  it("returns error when gh fails", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("create failed")
    })
    const result = await createTaskRecord({ title: "x", body: "b", parentIssueNumber: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("create failed")
    }
  })
})

describe("readTddEvidenceComment", () => {
  it("returns the controlled comment with its revision", async () => {
    const body = buildEvidenceCommentBody("## red\n- result: FAIL", 2)
    setRecordsGhExecutor(async () => ({ stdout: JSON.stringify({ id: 7, body }), stderr: "" }))

    const comment = await readTddEvidenceComment(42)
    expect(comment).not.toBeNull()
    if (comment) {
      expect(comment.id).toBe(7)
      expect(comment.revision).toBe(2)
    }
  })

  it("returns null when no controlled comment exists", async () => {
    setRecordsGhExecutor(async () => ({ stdout: "null", stderr: "" }))
    expect(await readTddEvidenceComment(42)).toBeNull()
  })

  it("returns null on gh failure", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("boom")
    })
    expect(await readTddEvidenceComment(42)).toBeNull()
  })
})

describe("appendTddEvidence", () => {
  function makeState() {
    const calls: string[] = []
    const comments: { id: number; body: string }[] = []
    const parseBodyArg = (args: string): string => {
      // 兼容 gh issue comment 的 "--body '..." 与 gh api 的 "-f body='..."
      const m = args.match(/(?:--body |body=')([\s\S]*?)'$/)
      return m ? m[1] : ""
    }
    const ghFn = async (args: string): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args)
      if (args.startsWith("issue view") && args.includes("--json comments")) {
        // 与实现一致：取最新的受控 comment
        const latest = [...comments].reverse().find(c => c.body.includes(EVIDENCE_MARKER_START))
        return { stdout: latest ? JSON.stringify({ id: latest.id, body: latest.body }) : "null", stderr: "" }
      }
      if (args.startsWith("issue comment")) {
        comments.push({ id: comments.length + 1, body: parseBodyArg(args) })
        return { stdout: "", stderr: "" }
      }
      if (args.startsWith("repo view")) {
        return { stdout: "devcxl/opencode-cabbage", stderr: "" }
      }
      if (args.startsWith("api repos/")) {
        const match = args.match(/issues\/comments\/(\d+) -X PATCH -f body='/)
        if (match) {
          const id = Number(match[1])
          const idx = comments.findIndex(c => c.id === id)
          comments[idx] = { id, body: parseBodyArg(args) }
        }
        return { stdout: "", stderr: "" }
      }
      throw new Error(`unexpected gh call: ${args}`)
    }
    return { ghFn, calls, comments }
  }

  it("creates a new controlled comment with revision 1 when none exists", async () => {
    const { ghFn, calls, comments } = makeState()
    setRecordsGhExecutor(ghFn)

    const result = await appendTddEvidence(42, "## red\n- result: FAIL")
    expect(result).toEqual({ ok: true, revision: 1 })
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain(EVIDENCE_MARKER_START)
    expect(comments[0].body).toContain("## red")
    expect(calls.some(c => c.startsWith("issue comment 42"))).toBe(true)
  })

  it("appends a new block to the existing controlled comment and bumps revision", async () => {
    const { ghFn, comments } = makeState()
    setRecordsGhExecutor(ghFn)
    await appendTddEvidence(42, "## red\n- result: FAIL")
    setRecordsGhExecutor(ghFn)

    const result = await appendTddEvidence(42, "## green\n- result: PASS")
    expect(result).toEqual({ ok: true, revision: 2 })
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain("## red")
    expect(comments[0].body).toContain("## green")
    expect(comments[0].body).toContain("revision:2")
  })

  it("is idempotent: appending an existing block does not duplicate it", async () => {
    const { ghFn, comments } = makeState()
    setRecordsGhExecutor(ghFn)
    await appendTddEvidence(42, "## red\n- result: FAIL")
    setRecordsGhExecutor(ghFn)

    const result = await appendTddEvidence(42, "## red\n- result: FAIL")
    expect(result).toEqual({ ok: true, revision: 1 })
    expect(comments).toHaveLength(1)
    const occurrences = comments[0].body.split("## red").length - 1
    expect(occurrences).toBe(1)
  })

  it("serializes concurrent appends via mutex without losing blocks", async () => {
    const { ghFn, comments } = makeState()
    setRecordsGhExecutor(ghFn)

    const blocks = Array.from({ length: 8 }, (_, i) => `## cycle-${i}\n- result: PASS`)
    const results = await Promise.all(blocks.map((b, i) => appendTddEvidence(42, b)))
    for (const r of results) {
      expect(r.ok).toBe(true)
    }
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain("revision:8")
    for (const b of blocks) {
      expect(comments[0].body).toContain(b)
    }
  })

  it("rolls over to a new controlled comment when the latest comment exceeds the size cap", async () => {
    const { ghFn, comments } = makeState()
    setRecordsGhExecutor(ghFn)
    // 第一条 comment 超限（略大于 MAX_EVIDENCE_COMMENT_BYTES）
    const big = "x".repeat(MAX_EVIDENCE_COMMENT_BYTES + 100)
    const r1 = await appendTddEvidence(42, big)
    expect(r1).toEqual({ ok: true, revision: 1 })
    expect(comments).toHaveLength(1)

    // 第二条走滚动：新建 comment，revision 继续
    const r2 = await appendTddEvidence(42, "## green\n- result: PASS")
    expect(r2).toEqual({ ok: true, revision: 2 })
    expect(comments).toHaveLength(2)
    expect(comments[1].body).toContain("revision:2")
    expect(comments[1].body).toContain("## green")

    // 后续追加到最新 comment（不回到旧 comment）
    const r3 = await appendTddEvidence(42, "## final\n- result: PASS")
    expect(r3).toEqual({ ok: true, revision: 3 })
    expect(comments).toHaveLength(2)
    expect(comments[1].body).toContain("## final")
  })

  it("readTddEvidenceComment returns the latest controlled comment across rollover", async () => {
    const { ghFn, comments } = makeState()
    setRecordsGhExecutor(ghFn)
    await appendTddEvidence(42, "x".repeat(MAX_EVIDENCE_COMMENT_BYTES + 100))
    await appendTddEvidence(42, "## green\n- result: PASS")

    const latest = await readTddEvidenceComment(42)
    expect(latest).not.toBeNull()
    if (latest) {
      expect(latest.id).toBe(2)
      expect(latest.revision).toBe(2)
      expect(latest.body).toContain("## green")
    }
  })

  it("returns error when gh fails", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("boom")
    })
    const result = await appendTddEvidence(42, "## red")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("boom")
    }
  })
})

describe("setStageLabel", () => {
  it("adds the target stage label and removes stale stage labels", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("issue view")) {
        return { stdout: "cabbage:flow cabbage:stage:requirements", stderr: "" }
      }
      return { stdout: "", stderr: "" }
    })

    const result = await setStageLabel(42, "design")
    expect(result).toEqual({ ok: true })
    const editCall = calls.find(c => c.startsWith("issue edit"))
    expect(editCall).toBeDefined()
    if (editCall) {
      expect(editCall).toContain("--remove-label 'cabbage:stage:requirements'")
      expect(editCall).toContain("--add-label 'cabbage:stage:design'")
      // flow 标签不被移除
      expect(editCall).not.toContain("cabbage:flow")
    }
  })

  it("auto-creates the target label before adding it (label 不预建时不再失败)", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("issue view")) return { stdout: "", stderr: "" }
      return { stdout: "", stderr: "" }
    })

    const result = await setStageLabel(42, "requirements")
    expect(result).toEqual({ ok: true })
    expect(calls.some(c => c.includes("label create 'cabbage:stage:requirements' --force"))).toBe(true)
  })

  it("keeps the current stage label unchanged", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("issue view")) {
        return { stdout: "cabbage:flow cabbage:stage:code", stderr: "" }
      }
      return { stdout: "", stderr: "" }
    })

    await setStageLabel(42, "code")
    const editCall = calls.find(c => c.startsWith("issue edit"))
    expect(editCall).toBeDefined()
    if (editCall) {
      expect(editCall).not.toContain("--remove-label")
      expect(editCall).toContain("--add-label 'cabbage:stage:code'")
    }
  })

  it("handles an issue with no labels", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("issue view")) {
        return { stdout: "", stderr: "" }
      }
      return { stdout: "", stderr: "" }
    })

    const result = await setStageLabel(42, "tasks")
    expect(result).toEqual({ ok: true })
    const editCall = calls.find(c => c.startsWith("issue edit"))
    expect(editCall).toBeDefined()
    if (editCall) {
      expect(editCall).toContain("--add-label 'cabbage:stage:tasks'")
      expect(editCall).not.toContain("--remove-label")
    }
  })

  it("returns error when gh fails", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("label failed")
    })
    const result = await setStageLabel(42, "design")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("label failed")
    }
  })
})

describe("evidence comment 纯函数", () => {
  it("builds a marker-wrapped comment body with revision", () => {
    const body = buildEvidenceCommentBody("## red\n- test: x\n- result: FAIL", 1)
    expect(body).toContain(EVIDENCE_MARKER_START)
    expect(body).toContain(EVIDENCE_MARKER_END)
    expect(body).toContain("## red")
    expect(body).toContain("revision:1")
    // marker 包裹：正文位于两个 marker 之间
    expect(body.indexOf(EVIDENCE_MARKER_START)).toBeLessThan(body.indexOf("## red"))
    expect(body.indexOf("## red")).toBeLessThan(body.indexOf(EVIDENCE_MARKER_END))
  })

  it("extracts revision and content from a marker-wrapped body", () => {
    const block = "## green\n- result: PASS"
    const body = buildEvidenceCommentBody(block, 3)
    const extracted = extractEvidenceBlock(body)
    expect(extracted).not.toBeNull()
    if (extracted) {
      expect(extracted.revision).toBe(3)
      expect(extracted.content).toContain(block)
    }
  })

  it("returns null when markers are absent", () => {
    expect(extractEvidenceBlock("# plain comment")).toBeNull()
  })

  it("returns null on malformed body with markers only", () => {
    expect(extractEvidenceBlock(EVIDENCE_MARKER_START + EVIDENCE_MARKER_END)).toBeNull()
  })
})
