/**
 * Everything a view (the side panel; the full page from M3) runs on, as one layer. The parts are
 * separate so tests can swap the browser-facing ones for fakes and keep the rest real.
 */
import { Layer } from "effect"
import type { QuestionsInbox } from "../agent/Questions.ts"
import { TriageAgent } from "../agent/TriageAgent.ts"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { WorkerClient } from "../messaging/WorkerClient.ts"
import { RunLocks } from "../runs/RunLocks.ts"
import { StoreReader } from "../store/StoreReader.ts"
import { PageTabs } from "./PageTabs.ts"
import { RelayChannel, Tidy } from "./Tidy.ts"

/** What views use. Writes go through `WorkerClient`; reads come from `StoreReader` and `PageTabs`. */
export type PanelServices = WorkerClient | StoreReader | PageTabs | Tidy

export interface PanelParts {
  readonly worker: Layer.Layer<WorkerClient>
  readonly reader: Layer.Layer<StoreReader>
  /** The API agent and its in-page Questions inbox (`TriageAgent.layerPage` in an extension page). */
  readonly agent: Layer.Layer<TriageAgent | QuestionsInbox, never, WorkerClient | StoreReader>
  readonly locks: Layer.Layer<RunLocks>
  readonly channel: Layer.Layer<RelayChannel>
  readonly tabs: Layer.Layer<PageTabs>
}

export const makePanelLayer = (parts: PanelParts): Layer.Layer<PanelServices> =>
  Tidy.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(parts.agent, parts.locks, parts.channel, parts.tabs)),
    Layer.provideMerge(Layer.mergeAll(parts.worker, parts.reader))
  )

/** The real thing, for an extension page. */
export const livePanelLayer: Layer.Layer<PanelServices> = makePanelLayer({
  worker: WorkerClient.layer,
  reader: StoreReader.layer.pipe(Layer.provide(ChromeApi.layer)),
  agent: TriageAgent.layerPage,
  locks: RunLocks.layer,
  channel: RelayChannel.layer,
  tabs: PageTabs.layer
})
