/**
 * Settings (canvas v6): the builder details live here, not on the main screens. The API key
 * (masked once saved, replaceable), the model, usage and cost, what Claude sees, and a way out
 * when stored data can't be read.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { API_MODELS, type ApiModel, isApiModel, modelOf, type ResettableKey, type Run, SENSITIVE_HOSTS, type Settings as SettingsValue } from "@wherefore/core"
import { DateTime } from "effect"
import { type FormEvent, useState } from "react"
import { AsyncResult } from "../../unstable.ts"
import { resetStoreKey, saveApiKey, setModel } from "../actions.ts"
import { itemsAtom, runsAtom, screenAtom, settingsAtom } from "../atoms.ts"
import { formatUsd, maskKey, plural, startOfWeek } from "../format.ts"
import { useAct } from "../hooks.ts"
import { StoreProblem, SubHeader } from "./common.tsx"
import { PRIVACY_DETAILS } from "./privacy.ts"

export function Settings() {
  const settings = useAtomValue(settingsAtom)
  const items = useAtomValue(itemsAtom)
  const runs = useAtomValue(runsAtom)
  const setScreen = useAtomSet(screenAtom)
  return (
    <div className="wf-screen">
      <SubHeader title="Settings" onBack={() => setScreen({ name: "home" })} />
      <main className="wf-main">
        {AsyncResult.isSuccess(settings) ? <Connection settings={settings.value} /> : null}
        {AsyncResult.isFailure(settings) ? <Recover storeKey="settings" what="Your settings" /> : null}
        {AsyncResult.isSuccess(runs) ? <Usage runs={runs.value.runs} /> : null}
        {AsyncResult.isFailure(runs) ? <Recover storeKey="runIndex" what="Your tidy-up history" /> : null}
        {AsyncResult.isFailure(items) ? <Recover storeKey="items" what="Your list" /> : null}
        <Privacy />
      </main>
    </div>
  )
}

function Recover({ storeKey, what }: { readonly storeKey: ResettableKey; readonly what: string }) {
  const act = useAct()
  const [busy, setBusy] = useState(false)
  const reset = async () => {
    setBusy(true)
    await act(resetStoreKey(storeKey), () => `${what} started fresh. The old copy is kept in storage.`)
    setBusy(false)
  }
  return <StoreProblem what={what} onReset={reset} busy={busy} />
}

function Connection({ settings }: { readonly settings: SettingsValue }) {
  const act = useAct()
  const [replacing, setReplacing] = useState(settings.apiKey === undefined)
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const model = modelOf(settings)

  const saveKey = async (event: FormEvent) => {
    event.preventDefault()
    if (key.trim() === "") return
    setBusy(true)
    const saved = await act(saveApiKey(key), () => "Key saved.")
    setBusy(false)
    if (saved._tag === "Some") {
      setKey("")
      setReplacing(false)
    }
  }

  return (
    <section className="wf-settings-section" aria-labelledby="settings-connection">
      <h2 id="settings-connection" className="wf-group-title">Connection</h2>
      <div className="wf-card wf-settings-card">
        <div className="wf-settings-row">
          <span className={settings.apiKey === undefined ? "wf-dot wf-dot-off" : "wf-dot"} aria-hidden="true" />
          <span className="wf-grow wf-stack">
            <span className="wf-strong">Anthropic API key</span>
            <span className="wf-sub">
              {settings.apiKey === undefined ? "No key yet" : `Saved · ${maskKey(settings.apiKey)}`}
            </span>
          </span>
          {settings.apiKey !== undefined && !replacing
            ? (
              <button type="button" className="wf-button wf-button-small" onClick={() => setReplacing(true)}>
                Replace
              </button>
            )
            : null}
        </div>
        {replacing
          ? (
            <form className="wf-settings-row wf-key-form" onSubmit={saveKey}>
              <label className="wf-field wf-grow">
                <span className="wf-field-label">{settings.apiKey === undefined ? "API key" : "New API key"}</span>
                <input
                  type="password"
                  className="wf-input"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="wf-item-actions">
                <button type="submit" className="wf-button wf-button-small" disabled={busy || key.trim() === ""}>Save</button>
                {settings.apiKey === undefined ? null : (
                  <button type="button" className="wf-text-button" onClick={() => {
                    setKey("")
                    setReplacing(false)
                  }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )
          : null}
        <div className="wf-settings-row wf-settings-divider">
          <label htmlFor="settings-model" className="wf-grow">Model</label>
          <select
            id="settings-model"
            className="wf-select"
            value={model}
            onChange={(event) => {
              const chosen = event.target.value
              if (isApiModel(chosen)) void act(setModel(chosen as ApiModel), () => "Model saved.")
            }}
          >
            {API_MODELS.map((offered) => <option key={offered.id} value={offered.id}>{offered.name}</option>)}
          </select>
        </div>
      </div>
    </section>
  )
}

function Usage({ runs }: { readonly runs: ReadonlyArray<Run> }) {
  const since = startOfWeek(Date.now())
  const thisWeek = runs.filter((run) => DateTime.toEpochMillis(run.startedAt) >= since)
  const cost = thisWeek.reduce((sum, run) => sum + (run.usage.costUsd ?? 0), 0)
  return (
    <section className="wf-settings-section" aria-labelledby="settings-usage">
      <h2 id="settings-usage" className="wf-group-title">Usage</h2>
      <div className="wf-card wf-settings-card wf-stack wf-padded">
        <span className="wf-strong">This week: {plural(thisWeek.length, "tidy-up")}</span>
        <span className="wf-sub">
          {thisWeek.length === 0 ? "Costs show here after a tidy-up." : `About ${formatUsd(cost)} at Anthropic's list prices.`}
        </span>
      </div>
    </section>
  )
}

function Privacy() {
  const hosts = [...SENSITIVE_HOSTS].sort()
  return (
    <section className="wf-settings-section" aria-labelledby="settings-privacy">
      <h2 id="settings-privacy" className="wf-group-title">Privacy</h2>
      <div className="wf-card wf-settings-card wf-stack wf-padded wf-privacy">
        {PRIVACY_DETAILS.map((line) => <p key={line}>{line}</p>)}
        <details>
          <summary>Sites Wherefore never reads</summary>
          <ul className="wf-host-list">
            {hosts.map((host) => <li key={host}>{host}</li>)}
          </ul>
        </details>
      </div>
    </section>
  )
}
