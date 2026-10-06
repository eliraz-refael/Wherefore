/**
 * The views' state, as Atoms (architecture A5/A7): the Store and the open tabs are streams the
 * worker and Chrome keep current (`StoreReader.watch`/`watchRuns`, `PageTabs.watch`), so a change
 * made anywhere (another panel, the worker, an undo) shows up everywhere. Views never write to
 * storage: actions go through the worker (actions.ts).
 *
 * `panelLayerAtom` holds the layer views run on. It is a plain value, so a test can give a
 * `RegistryProvider` a layer over fakes (`initialValues`); each registry builds its own copy.
 */
import type { RunId } from "@wherefore/core"
import { Effect, type Layer, Stream } from "effect"
import { itemsKey, settingsKey } from "../store/keys.ts"
import type { StoreKey } from "../store/StoreKey.ts"
import { StoreReader } from "../store/StoreReader.ts"
import { Atom } from "../unstable.ts"
import { PageTabs } from "./PageTabs.ts"
import { livePanelLayer, type PanelServices } from "./panelLayer.ts"
import type { Choices, TabRemap } from "./review.ts"
import type { Undo } from "./actions.ts"

export const panelLayerAtom = Atom.keepAlive(Atom.make<Layer.Layer<PanelServices>>(livePanelLayer))

/**
 * The services, built once per registry and kept for its lifetime: a run started from this page
 * lives in this runtime (architecture A4), so it must not be torn down while nothing watches it.
 */
export const panelRuntime = Atom.keepAlive(Atom.runtime((get) => get(panelLayerAtom)))

const watchKey = <A>(key: StoreKey<A>) => Stream.unwrap(Effect.map(Effect.service(StoreReader), (reader) => reader.watch(key)))

export const settingsAtom = Atom.keepAlive(panelRuntime.atom(watchKey(settingsKey)))
export const itemsAtom = Atom.keepAlive(panelRuntime.atom(watchKey(itemsKey)))
export const runsAtom = Atom.keepAlive(
  panelRuntime.atom(Stream.unwrap(Effect.map(Effect.service(StoreReader), (reader) => reader.watchRuns)))
)
export const openTabsAtom = Atom.keepAlive(
  panelRuntime.atom(Stream.unwrap(Effect.map(Effect.service(PageTabs), (tabs) => tabs.watch)))
)

export type Screen =
  | { readonly name: "home" }
  | { readonly name: "tidy"; readonly runId: RunId }
  | { readonly name: "done" }
  | { readonly name: "settings" }

export const screenAtom = Atom.keepAlive(Atom.make<Screen>({ name: "home" }))

/** The one toast: a message, and an undo while it shows. */
export interface Toast {
  readonly id: number
  readonly message: string
  readonly undo?: Undo
}
export const toastAtom = Atom.keepAlive(Atom.make<Toast | null>(null))

/** Restored tabs get new ids: every undo records them here, so a run's results still find them. */
export const remapAtom = Atom.keepAlive(Atom.make<TabRemap>(new Map()))

/** What the user changed on a run's results, kept while the panel is open. */
export const choicesAtom = Atom.family((_runId: RunId) => Atom.keepAlive(Atom.make<Choices>({})))
