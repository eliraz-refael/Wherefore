/**
 * The side panel: first run until there is an API key, then Your list (home), Tidy up, the Done
 * archive and Settings. One toast for outcomes and undo, in a live region.
 */
import { useAtomMount, useAtomValue } from "@effect/atom-react"
import type { RunId } from "@wherefore/core"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { AsyncResult, Atom } from "../../unstable.ts"
import { WorkerClient } from "../../messaging/WorkerClient.ts"
import { resetStoreKey } from "../actions.ts"
import { panelRuntime, runsAtom, screenAtom, settingsAtom } from "../atoms.ts"
import { focusSoon, useAct } from "../hooks.ts"
import { Tidy } from "../Tidy.ts"
import { StoreProblem } from "./common.tsx"
import { DoneArchive } from "./DoneArchive.tsx"
import { Home } from "./Home.tsx"
import { Onboarding } from "./Onboarding.tsx"
import { Settings } from "./Settings.tsx"
import { TidyScreen } from "./TidyScreen.tsx"
import { ToastRegion } from "./Toast.tsx"

/** Once per panel: runs left "running" by a page that is gone are marked interrupted. */
const checkRunsAtom = panelRuntime.atom(
  Effect.flatMap(Effect.service(WorkerClient), (worker) => worker.call("check_runs", undefined)).pipe(Effect.ignore)
)

/** While a run is running (here or elsewhere): notices when its page goes away. */
const goneAtom = Atom.family((id: RunId) => panelRuntime.atom(Effect.flatMap(Effect.service(Tidy), (tidy) => tidy.whenGone(id))))

export function App() {
  const settings = useAtomValue(settingsAtom)
  const screen = useAtomValue(screenAtom)
  useAtomMount(checkRunsAtom)

  // A new screen: move focus to its title, so keyboard and screen reader users start there.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    focusSoon("[data-screen-heading]")
  }, [screen])

  return (
    <div className="wf-app">
      {AsyncResult.match(settings, {
        onInitial: () => <p className="wf-muted wf-padded" role="status">Loading…</p>,
        onFailure: () => <SettingsProblem />,
        onSuccess: ({ value }) => {
          if (value.apiKey === undefined && screen.name !== "settings") return <Onboarding />
          switch (screen.name) {
            case "home":
              return <Home />
            case "tidy":
              return <TidyScreen runId={screen.runId} />
            case "done":
              return <DoneArchive />
            case "settings":
              return <Settings />
          }
        }
      })}
      <ToastRegion />
      <RunWatchers />
    </div>
  )
}

function SettingsProblem() {
  const act = useAct()
  const [busy, setBusy] = useState(false)
  return (
    <main className="wf-main">
      <StoreProblem
        what="Your settings"
        busy={busy}
        onReset={async () => {
          setBusy(true)
          await act(resetStoreKey("settings"), () => "Settings started fresh. The old copy is kept in storage.")
          setBusy(false)
        }}
      />
    </main>
  )
}

function RunWatchers() {
  const runs = useAtomValue(runsAtom)
  if (!AsyncResult.isSuccess(runs)) return null
  return runs.value.runs.filter((run) => run.status === "running").map((run) => <GoneWatcher key={run.id} id={run.id} />)
}

function GoneWatcher({ id }: { readonly id: RunId }) {
  useAtomMount(goneAtom(id))
  return null
}
