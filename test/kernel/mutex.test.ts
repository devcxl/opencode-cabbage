import { describe, it, expect } from "vitest"
import { KeyedMutex } from "../../src/kernel/mutex.js"

const tick = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe("KeyedMutex", () => {
  it("serializes operations with the same key", async () => {
    const mutex = new KeyedMutex()
    let inFlight = 0
    let maxInFlight = 0

    const op = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(10)
      inFlight -= 1
    }

    await Promise.all([mutex.runExclusive("k", op), mutex.runExclusive("k", op), mutex.runExclusive("k", op)])
    expect(maxInFlight).toBe(1)
  })

  it("runs operations with different keys in parallel", async () => {
    const mutex = new KeyedMutex()
    let inFlight = 0
    let maxInFlight = 0

    const op = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(10)
      inFlight -= 1
    }

    await Promise.all([mutex.runExclusive("a", op), mutex.runExclusive("b", op), mutex.runExclusive("c", op)])
    expect(maxInFlight).toBe(3)
  })

  it("returns the operation result", async () => {
    const mutex = new KeyedMutex()
    const result = await mutex.runExclusive("k", async () => 42)
    expect(result).toBe(42)
  })

  it("propagates errors and keeps the mutex usable afterwards", async () => {
    const mutex = new KeyedMutex()
    await expect(
      mutex.runExclusive("k", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    const result = await mutex.runExclusive("k", async () => "ok")
    expect(result).toBe("ok")
  })

  it("supports numeric keys", async () => {
    const mutex = new KeyedMutex()
    let inFlight = 0
    let maxInFlight = 0

    const op = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(5)
      inFlight -= 1
    }

    await Promise.all([mutex.runExclusive(1, op), mutex.runExclusive(1, op)])
    expect(maxInFlight).toBe(1)
  })
})
