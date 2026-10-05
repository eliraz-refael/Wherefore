/**
 * An in-memory Web Locks manager (`navigator.locks`), shared by several "clients" (pages and the
 * worker of one extension). Exclusive and shared modes, `ifAvailable`, abort signals, FIFO waiting,
 * and `query()`. `close(client)` drops everything a client holds, the way a closed page does:
 * without running any of its code.
 */
import { Layer } from "effect"
import { type LockManagerLike, makeWebLocks, RunLocks } from "../../src/runs/RunLocks.ts"

type Mode = "exclusive" | "shared"

interface Holder {
  readonly name: string
  readonly mode: Mode
  readonly client: number
}

interface Waiting extends Holder {
  readonly grant: () => void
}

export class FakeLockManager {
  private readonly holders: Array<Holder> = []
  private readonly waiting: Array<Waiting> = []
  private nextClient = 1

  private grantable(name: string, mode: Mode): boolean {
    const current = this.holders.filter((holder) => holder.name === name)
    return current.length === 0 || (mode === "shared" && current.every((holder) => holder.mode === "shared"))
  }

  private pump(): void {
    for (const request of [...this.waiting]) {
      const earlier = this.waiting.slice(0, this.waiting.indexOf(request)).some((w) => w.name === request.name)
      if (!earlier && this.grantable(request.name, request.mode)) {
        this.waiting.splice(this.waiting.indexOf(request), 1)
        request.grant()
      }
    }
  }

  /** A `LockManager` for one page or worker. */
  client(): LockManagerLike & { readonly id: number } {
    const client = this.nextClient++
    return {
      id: client,
      request: (name, options, callback) =>
        new Promise((resolve, reject) => {
          const mode = options.mode ?? "exclusive"
          const holder: Holder = { name, mode, client }
          const grant = () => {
            this.holders.push(holder)
            Promise.resolve(callback({ name, mode })).then(
              (value) => {
                const index = this.holders.indexOf(holder)
                if (index === -1) return // the client closed meanwhile
                this.holders.splice(index, 1)
                resolve(value)
                this.pump()
              },
              reject
            )
          }
          const queued = this.waiting.some((w) => w.name === name)
          if (!queued && this.grantable(name, mode)) return grant()
          if (options.ifAvailable === true) return void Promise.resolve(callback(null)).then(resolve, reject)
          const waiting: Waiting = { ...holder, grant }
          this.waiting.push(waiting)
          options.signal?.addEventListener("abort", () => {
            const index = this.waiting.indexOf(waiting)
            if (index !== -1) this.waiting.splice(index, 1)
            reject(new Error("AbortError"))
          }, { once: true })
        }),
      query: () => Promise.resolve({ held: this.holders.map(({ mode, name }) => ({ name, mode })) })
    }
  }

  /** The client's page closed: its locks and waiting requests are gone. */
  close(client: { readonly id: number }): void {
    for (let i = this.holders.length - 1; i >= 0; i--) if (this.holders[i]?.client === client.id) this.holders.splice(i, 1)
    for (let i = this.waiting.length - 1; i >= 0; i--) if (this.waiting[i]?.client === client.id) this.waiting.splice(i, 1)
    this.pump()
  }

  heldNames(): Array<string> {
    return this.holders.map((holder) => holder.name)
  }

  /** `RunLocks` for a new client of this manager, and the client (to `close` it later). */
  runLocks(): { readonly layer: Layer.Layer<RunLocks>; readonly client: { readonly id: number } } {
    const client = this.client()
    return { layer: Layer.succeed(RunLocks)(makeWebLocks(client)), client }
  }
}
