import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "../../unstable.ts"
import { versionAtom } from "./atoms.ts"

/** Placeholder. The real side panel (canvas v6) lands in a later M1 PR. */
export function App() {
  const version = useAtomValue(versionAtom)
  return (
    <main>
      <h1>Wherefore</h1>
      <p role="status">
        {AsyncResult.match(version, {
          onInitial: () => "Starting…",
          onFailure: () => "Couldn't read the extension version.",
          onSuccess: ({ value }) => `Version ${value}. Nothing to see yet.`,
        })}
      </p>
    </main>
  )
}
