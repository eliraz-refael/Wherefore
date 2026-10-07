/**
 * The brokers an MCP session can reach (architecture A3): one per connected Chrome profile, found
 * in the registry. Profiles come and go during a session (a profile's Chrome closes, the extension
 * reloads), so the registry is read again whenever the session needs the brokers, and connections
 * are kept per broker (its socket) until it disappears from the registry or a call to it fails.
 *
 * Scoped to one profile (`wherefore mcp --profile <id>`, what an ACP run uses), only that
 * profile's broker is used.
 */
import type { ProfileId } from "@wherefore/core"
import { Effect, Exit, Scope, Semaphore } from "effect"
import { type BrokerClient, connectBroker } from "../broker/BrokerClient.ts"
import type { RegistryEntry } from "../broker/registry.ts"

export interface Broker {
  readonly profileId: ProfileId
  readonly client: BrokerClient
}

export interface Brokers {
  /** The live brokers now, oldest profile first. Connections open on first use. */
  readonly current: Effect.Effect<ReadonlyArray<Broker>>
  /** Drops a broker that went away; the next `current` connects again if it is still registered. */
  readonly forget: (broker: Broker) => Effect.Effect<void>
  /** Set when the session is scoped to one profile. */
  readonly profile: ProfileId | undefined
}

interface Connection {
  readonly broker: Broker
  readonly scope: Scope.Closeable
}

export const makeBrokers = (options: {
  /** The registered brokers whose process is running (registry.ts `entries`). */
  readonly entries: Effect.Effect<ReadonlyArray<RegistryEntry>>
  readonly profile?: ProfileId | undefined
}): Effect.Effect<Brokers, never, Scope.Scope> =>
  Effect.gen(function*() {
    const outer = yield* Effect.scope
    const lock = Semaphore.makeUnsafe(1)
    const connections = new Map<string, Connection>()
    const keyOf = (entry: RegistryEntry) => `${entry.socket}\n${entry.token}`

    const close = (key: string) =>
      Effect.suspend(() => {
        const connection = connections.get(key)
        connections.delete(key)
        return connection === undefined ? Effect.void : Scope.close(connection.scope, Exit.void)
      })

    yield* Effect.addFinalizer(() => Effect.forEach([...connections.keys()], close, { discard: true }))

    // Calls still in flight on a retired connection fail on their own (its broker is gone); closing
    // it at once would interrupt them instead, so it closes a little later.
    const retire = (key: string) =>
      Effect.suspend(() => {
        const connection = connections.get(key)
        connections.delete(key)
        return connection === undefined
          ? Effect.void
          : Effect.asVoid(Effect.forkIn(Effect.delay(Scope.close(connection.scope, Exit.void), "3 seconds"), outer))
      })

    const current = Effect.gen(function*() {
      const entries = (yield* options.entries).filter((entry) =>
        options.profile === undefined || entry.profileId === options.profile
      )
      const live = new Set(entries.map(keyOf))
      for (const key of [...connections.keys()]) if (!live.has(key)) yield* retire(key)
      const brokers: Array<Broker> = []
      for (const entry of [...entries].sort((a, b) => a.startedAt - b.startedAt)) {
        const key = keyOf(entry)
        let connection = connections.get(key)
        if (connection === undefined) {
          const scope = yield* Scope.fork(outer)
          const client = yield* connectBroker(entry.socket, entry.token).pipe(Scope.provide(scope))
          connection = { broker: { profileId: entry.profileId, client }, scope }
          connections.set(key, connection)
        }
        brokers.push(connection.broker)
      }
      // Two entries for one profile can't happen (one file per profile), but keep the newest anyway.
      const byProfile = new Map(brokers.map((broker) => [broker.profileId, broker]))
      return [...byProfile.values()]
    }).pipe(Semaphore.withPermit(lock))

    const forget = (broker: Broker) =>
      Effect.suspend(() => {
        const key = [...connections].find(([, connection]) => connection.broker === broker)?.[0]
        return key === undefined ? Effect.void : retire(key)
      }).pipe(Semaphore.withPermit(lock))

    return { current, forget, profile: options.profile }
  })
