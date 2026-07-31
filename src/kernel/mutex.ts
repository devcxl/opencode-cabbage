/**
 * 按 key 隔离的互斥锁，用于单进程内串行化并发操作。
 * 相同 key 的操作依次执行，不同 key 的操作可并行。
 */
export class KeyedMutex {
  private locks = new Map<string | number, Promise<void>>()

  async runExclusive<T>(key: string | number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release: () => void
    const next = new Promise<void>(r => {
      release = r
    })
    this.locks.set(key, next)

    await prev
    try {
      return await fn()
    } finally {
      release!()
    }
  }
}
