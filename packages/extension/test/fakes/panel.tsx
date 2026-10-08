/**
 * Side panels over one fake browser, for UI tests: the real worker (over fake Ports), the real
 * agent over a scripted model, real Store reads, and fake tabs, locks and page-to-page channel.
 * Each `open()` is one panel (its own registry, Port, inbox and Web Locks client), as in a window.
 */
import { RegistryProvider } from "@effect/atom-react"
import { render, type RenderResult, within } from "@testing-library/react"
import { Effect, Layer } from "effect"
import { QuestionsInbox } from "../../src/agent/Questions.ts"
import { TriageAgent } from "../../src/agent/TriageAgent.ts"
import { itemsKey } from "../../src/store/keys.ts"
import { StoreReader } from "../../src/store/StoreReader.ts"
import { panelLayerAtom } from "../../src/ui/atoms.ts"
import { App } from "../../src/ui/components/App.tsx"
import { makePanelLayer } from "../../src/ui/panelLayer.ts"
import type { FakeChrome } from "./chrome.ts"
import { Harness } from "./harness.ts"
import { ScriptedModel } from "./model.ts"
import { FakeNativeHost } from "./native.ts"
import { FakeRelayHub, fakePageTabs } from "./page.ts"

export interface View extends RenderResult {
  /** Queries scoped to this panel. */
  readonly ui: ReturnType<typeof within>
  /** "Show me" calls, by tab id. */
  readonly shown: Array<number>
  /** The page closes the way a real one does: its Web Locks drop, none of its code runs. */
  readonly crash: () => void
}

export class Panels {
  readonly harness: Harness
  readonly hub = new FakeRelayHub()

  constructor(
    readonly chrome: FakeChrome,
    readonly model: ScriptedModel = new ScriptedModel([]),
    readonly native: FakeNativeHost = new FakeNativeHost("missing")
  ) {
    this.harness = new Harness(chrome, native)
  }

  readonly start = () => Effect.runPromise(this.harness.startWorker)
  readonly stop = () => Effect.runPromise(this.harness.killWorker)

  open(windowId = 1): View {
    const locks = this.harness.locks.runLocks()
    const shown: Array<number> = []
    const layer = makePanelLayer({
      worker: this.harness.clientLayer,
      reader: StoreReader.layer.pipe(Layer.provide(this.chrome.layer)),
      agent: TriageAgent.layer.pipe(Layer.provideMerge(Layer.mergeAll(QuestionsInbox.layer, this.model.layer, locks.layer))),
      locks: locks.layer,
      channel: this.hub.channel(),
      tabs: fakePageTabs(this.chrome, windowId, shown)
    })
    const rendered = render(
      <RegistryProvider initialValues={[[panelLayerAtom, layer]]}>
        <App />
      </RegistryProvider>
    )
    return {
      ...rendered,
      ui: within(rendered.container),
      shown,
      crash: () => this.harness.locks.close(locks.client)
    }
  }
}

/** A value as the Store keeps it. */
export const envelope = (data: unknown) => ({ version: 1, data })

/** The user's list as the Store keeps it, at the current version. */
export const itemsEnvelope = (data: unknown) => ({ version: itemsKey.version, data })

export const ISO_NOW = () => new Date().toISOString()

/**
 * When a fixture item was saved, unless the test says: one instant for all of them, so items built
 * together tie and the list keeps their stored order. (Stamping each with the clock let the list's
 * newest-first order flip whenever a millisecond passed between building two of them.)
 */
const SAVED_AT = ISO_NOW()

/** A saved item in its stored (JSON) form. */
export const storedItem = (fields: {
  readonly id: string
  readonly task: string
  /** The short title; the task when not given. */
  readonly title?: string
  readonly why?: string
  readonly tag?: "do" | "track" | "decide" | "read" | "keep"
  readonly due?: { readonly date: string; readonly kind: "due" | "event" | "renews" | "expires" | "starts"; readonly source: string }
  readonly tabs: ReadonlyArray<{ readonly title: string; readonly url: string }>
  readonly status?: "open" | "done"
  readonly savedAt?: string
  readonly doneAt?: string
}) => ({
  id: fields.id,
  tag: fields.tag ?? "do",
  title: fields.title ?? fields.task,
  task: fields.task,
  intention: fields.task,
  why: fields.why ?? "Because",
  ...(fields.due === undefined ? {} : { due: fields.due }),
  tabs: fields.tabs.map((tab) => ({ ...tab, domain: new URL(tab.url).hostname.replace(/^www\./, "") })),
  status: fields.status ?? "open",
  savedAt: fields.savedAt ?? SAVED_AT,
  ...(fields.status === "done" ? { doneAt: fields.doneAt ?? ISO_NOW() } : {})
})

export const SETTINGS = envelope({ apiKey: "sk-ant-test-0123456789-wxyz" })
