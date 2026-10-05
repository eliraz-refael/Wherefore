/**
 * First run, API mode (M1): the promise, an Anthropic API key, and what Claude gets to see. The
 * canvas's "Uses your Claude Code login" needs the companion (M2).
 */
import { API_MODELS, DEFAULT_MODEL } from "@wherefore/core"
import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, useState } from "react"
import { saveApiKey } from "../actions.ts"
import { screenAtom } from "../atoms.ts"
import { useAct } from "../hooks.ts"
import { LogoIcon } from "./common.tsx"
import { PRIVACY_SHORT } from "./privacy.ts"

const KEYS_URL = "https://console.anthropic.com/settings/keys"

export function Onboarding() {
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const act = useAct()
  const setScreen = useAtomSet(screenAtom)
  const modelName = API_MODELS.find((model) => model.id === DEFAULT_MODEL)?.name ?? DEFAULT_MODEL

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (key.trim() === "") return
    setBusy(true)
    const saved = await act(saveApiKey(key), () => "Key saved. You're ready to tidy up.")
    setBusy(false)
    if (saved._tag === "Some") {
      setKey("")
      setScreen({ name: "home" })
    }
  }

  return (
    <div className="wf-onboarding">
      <header className="wf-brand">
        <LogoIcon />
        <span className="wf-brand-name">Wherefore</span>
      </header>
      <main className="wf-onboarding-main">
        <h1 className="wf-hero" tabIndex={-1} data-screen-heading="">Close every tab without losing what it was for.</h1>
        <p className="wf-lead">
          Each tab is open for a reason: something to do, check or read. Wherefore writes the reasons down, so the tabs
          can go.
        </p>
      </main>
      <form className="wf-onboarding-form" onSubmit={submit}>
        <label className="wf-field">
          <span className="wf-field-label">Anthropic API key</span>
          <input
            type="password"
            className="wf-input"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="wf-key-help"
          />
        </label>
        <p id="wf-key-help" className="wf-help">
          Wherefore runs on Claude with your own key, which stays in this browser.{" "}
          <a href={KEYS_URL} target="_blank" rel="noreferrer">Get a key</a>
        </p>
        <button type="submit" className="wf-primary" disabled={busy || key.trim() === ""}>
          Save key and continue
        </button>
        <p className="wf-help wf-center">
          Uses {modelName} ·{" "}
          <button type="button" className="wf-inline-link" onClick={() => setScreen({ name: "settings" })}>Change</button>
        </p>
        <p className="wf-fine">
          {PRIVACY_SHORT}{" "}
          <button type="button" className="wf-inline-link" onClick={() => setScreen({ name: "settings" })}>Details</button>
        </p>
      </form>
    </div>
  )
}
