import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSetupControlTool, registerSetupControl } from "../../src/plugin/setup-control.js"
import { setSetupGitExecutor, setSetupGhExecutor } from "../../src/kernel/setup.js"
import type { CallerSessionClient } from "../../src/kernel/caller.js"

const primaryClient: CallerSessionClient = {
  session: { get: async () => ({ data: { parentID: null } }) },
}
const childClient: CallerSessionClient = {
  session: { get: async () => ({ data: { parentID: "parent" } }) },
}

function makeCtx(agent: string, sessionID: string) {
  return {
    agent,
    sessionID,
    messageID: "m1",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

async function executeOp(
  dir: string,
  op: string,
  args: Record<string, unknown> = {},
  client: CallerSessionClient = primaryClient,
  agent = "dev-lifecycle",
): Promise<Record<string, any>> {
  const t = createSetupControlTool({ projectDir: dir, sessionClient: client })
  const out = await t.execute({ op, ...args }, makeCtx(agent, "sess-1") as never)
  return JSON.parse(String(out)) as Record<string, any>
}

async function withProjectDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cabbage-setup-tool-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("createSetupControlTool", () => {
  beforeEach(() => {
    setSetupGitExecutor(() => {
      throw new Error("unexpected git call")
    })
    setSetupGhExecutor(() => {
      throw new Error("unexpected gh call")
    })
  })

  afterEach(() => {
    setSetupGitExecutor(null)
    setSetupGhExecutor(null)
  })

  it("defines the three ops in the args schema", () => {
    const t = createSetupControlTool({ projectDir: ".", sessionClient: primaryClient })
    const opSchema = t.args.op as { safeParse(value: unknown): { success: boolean } }
    for (const op of ["probe", "generate-workflows", "confirm-profile"]) {
      expect(opSchema.safeParse(op).success).toBe(true)
    }
    expect(opSchema.safeParse("bogus").success).toBe(false)
  })

  it("runs probe and returns the readiness report", async () => {
    await withProjectDir(async dir => {
      setSetupGitExecutor(async () => ({ stdout: "", stderr: "" }))
      setSetupGhExecutor(async () => ({ stdout: "", stderr: "" }))

      const resp = await executeOp(dir, "probe")
      expect(resp.ok).toBe(true)
      expect(resp.readiness).toBeDefined()
      expect(typeof resp.readiness.developmentReady).toBe("boolean")
      expect(typeof resp.readiness.releaseReady).toBe("boolean")
    })
  })

  it("confirm-profile writes the profile back to AGENTS.md", async () => {
    await withProjectDir(async dir => {
      await writeFile(join(dir, "AGENTS.md"), "# Rules\n")

      const resp = await executeOp(dir, "confirm-profile", {
        profile_overrides: JSON.stringify({ testCommand: "cabbage-test-tool run" }),
      })
      expect(resp.ok).toBe(true)
      expect(resp.profileConfirmed).toBe(true)
    })
  })

  it("confirm-profile requires profile_overrides", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, "confirm-profile")
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("POLICY_INVALID")
    })
  })

  it("generate-workflows creates the drafts and returns the PR number", async () => {
    await withProjectDir(async dir => {
      await writeFile(join(dir, "AGENTS.md"), "# Rules\n")
      setSetupGitExecutor(async (args) => {
        if (args.includes("symbolic-ref")) return { stdout: "main", stderr: "" }
        return { stdout: "", stderr: "" }
      })
      setSetupGhExecutor(async () => ({ stdout: "5", stderr: "" }))

      const resp = await executeOp(dir, "generate-workflows", { pr_title: "chore: add workflows" })
      expect(resp.ok).toBe(true)
      expect(resp.created).toContain(".github/workflows/ci.yml")
      expect(resp.prNumber).toBe(5)
    })
  })

  it("rejects a non-primary caller with CALLER_NOT_AUTHORIZED", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, "probe", {}, childClient, "developer")
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("CALLER_NOT_AUTHORIZED")
    })
  })

  it("returns UNKNOWN_OP for an unknown op", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, "bogus" as string)
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("UNKNOWN_OP")
    })
  })
})

describe("registerSetupControl", () => {
  it("mounts setup_control on the tool registry", () => {
    const registry: Record<string, unknown> = {}
    registerSetupControl(registry, { projectDir: ".", sessionClient: primaryClient })
    expect(registry.setup_control).toBeDefined()
  })
})
