/**
 * First run (canvas v6 "Onboarding"): the promise, then the way in.
 *
 * - **The companion is connected:** the main path is Claude Code, on the user's own Claude Code
 *   login: "Tidy up my N tabs" chooses it and starts a tidy-up. "Use an API key instead" is the
 *   other path.
 * - **Otherwise:** an Anthropic API key, as in M1, with a short hint that Claude Code works too once
 *   the companion is installed.
 *
 * Either way, what Claude gets to see, in one line.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { API_MODELS, DEFAULT_MODEL } from "@wherefore/core"
import { type FormEvent, useState } from "react"
import { AsyncResult } from "../../unstable.ts"
import { chooseApiKey, startWithClaudeCode } from "../actions.ts"
import { companionAtom, openTabsAtom, screenAtom } from "../atoms.ts"
import { useAct } from "../hooks.ts"
import { LogoIcon } from "./common.tsx"
import { PRIVACY_SHORT } from "./privacy.ts"

const KEYS_URL = "https://console.anthropic.com/settings/keys"

/** The companion's install steps (its README, in this repository). */
export const COMPANION_README_URL = "https://github.com/eliraz-refael/Wherefore/blob/main/packages/companion/README.md"

export function Onboarding() {
  const companion = useAtomValue(companionAtom)
  const [wantsKey, setWantsKey] = useState(false)
  const connected = AsyncResult.isSuccess(companion) && companion.value._tag === "Connected"

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
      {connected && !wantsKey
        ? <ClaudeCodePath onUseKey={() => setWantsKey(true)} />
        : <ApiKeyPath connected={connected} onUseClaudeCode={() => setWantsKey(false)} />}
    </div>
  )
}

function ClaudeCodePath({ onUseKey }: { readonly onUseKey: () => void }) {
  const act = useAct()
  const setScreen = useAtomSet(screenAtom)
  const tabs = useAtomValue(openTabsAtom)
  const [busy, setBusy] = useState(false)
  const count = AsyncResult.isSuccess(tabs) ? tabs.value.length : undefined

  const start = async () => {
    setBusy(true)
    const started = await act(startWithClaudeCode)
    setBusy(false)
    if (started._tag === "Some") setScreen({ name: "tidy", runId: started.value })
  }

  return (
    <div className="wf-onboarding-form">
      <button type="button" className="wf-primary" onClick={start} disabled={busy}>
        {count === undefined || count === 0 ? "Tidy up my tabs" : count === 1 ? "Tidy up my tab" : `Tidy up my ${count} tabs`}
      </button>
      <p className="wf-help wf-center">
        Uses your Claude Code login ·{" "}
        <button type="button" className="wf-inline-link" onClick={onUseKey}>Use an API key instead</button>
      </p>
      <p className="wf-fine">
        {PRIVACY_SHORT}{" "}
        <button type="button" className="wf-inline-link" onClick={() => setScreen({ name: "settings" })}>Details</button>
      </p>
    </div>
  )
}

function ApiKeyPath({ connected, onUseClaudeCode }: { readonly connected: boolean; readonly onUseClaudeCode: () => void }) {
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const act = useAct()
  const setScreen = useAtomSet(screenAtom)
  const modelName = API_MODELS.find((model) => model.id === DEFAULT_MODEL)?.name ?? DEFAULT_MODEL

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (key.trim() === "") return
    setBusy(true)
    const saved = await act(chooseApiKey(key), () => "Key saved. You're ready to tidy up.")
    setBusy(false)
    if (saved._tag === "Some") {
      setKey("")
      setScreen({ name: "home" })
    }
  }

  return (
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
      <p className="wf-help wf-center">
        {connected
          ? (
            <>
              Have Claude Code?{" "}
              <button type="button" className="wf-inline-link" onClick={onUseClaudeCode}>Use your Claude Code login</button>
            </>
          )
          : (
            <>
              Use Claude Code instead:{" "}
              <a href={COMPANION_README_URL} target="_blank" rel="noreferrer">install the companion</a>
            </>
          )}
      </p>
      <p className="wf-fine">
        {PRIVACY_SHORT}{" "}
        <button type="button" className="wf-inline-link" onClick={() => setScreen({ name: "settings" })}>Details</button>
      </p>
    </form>
  )
}
