/**
 * Settings (canvas v6): the builder details live here, not on the main screens. How tidy-ups run
 * (Claude Code through the companion, or an API key); for Claude Code its model and effort as the
 * agent offers them and the agent's command; for the API key the key (masked once saved,
 * replaceable) and the model; the companion's status; usage and cost; what Claude sees; and a way
 * out when stored data can't be read.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  type AgentOptions,
  type AgentSetting,
  agentCommandOf,
  agentLabel,
  API_MODELS,
  type ApiModel,
  type CompanionStatus,
  DEFAULT_AGENT_COMMAND,
  isApiModel,
  modelOf,
  type ResettableKey,
  type Run,
  SENSITIVE_HOSTS,
  type Settings as SettingsValue,
  shownPref,
  tidyModeOf
} from "@wherefore/core"
import { DateTime } from "effect"
import { type FormEvent, useState } from "react"
import { AsyncResult } from "../../unstable.ts"
import { checkCompanion, resetStoreKey, saveApiKey, setAgentCommand, setAgentPref, setModel, setTidyMode } from "../actions.ts"
import { agentOptionsAtom, companionAtom, itemsAtom, runsAtom, screenAtom, settingsAtom } from "../atoms.ts"
import { formatUsd, maskKey, plural, startOfWeek } from "../format.ts"
import { useAct } from "../hooks.ts"
import { StoreProblem, SubHeader } from "./common.tsx"
import { COMPANION_README_URL } from "./Onboarding.tsx"
import { PRIVACY_DETAILS } from "./privacy.ts"

export function Settings() {
  const settings = useAtomValue(settingsAtom)
  const items = useAtomValue(itemsAtom)
  const runs = useAtomValue(runsAtom)
  const companion = useAtomValue(companionAtom)
  const setScreen = useAtomSet(screenAtom)
  return (
    <div className="wf-screen">
      <SubHeader title="Settings" onBack={() => setScreen({ name: "home" })} />
      <main className="wf-main">
        {AsyncResult.isSuccess(settings)
          ? (
            <Connection
              settings={settings.value}
              companion={AsyncResult.isSuccess(companion) ? companion.value : { _tag: "Checking" }}
            />
          )
          : null}
        {AsyncResult.isFailure(settings) ? <Recover storeKey="settings" what="Your settings" /> : null}
        {AsyncResult.isSuccess(companion) ? <Companion status={companion.value} /> : null}
        {AsyncResult.isSuccess(runs)
          ? <Usage runs={runs.value.runs} claudeCode={AsyncResult.isSuccess(settings) && tidyModeOf(settings.value) === "companion"} />
          : null}
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

function Connection({ settings, companion }: { readonly settings: SettingsValue; readonly companion: CompanionStatus }) {
  const act = useAct()
  const mode = tidyModeOf(settings)
  const choose = (next: "companion" | "api") => {
    // Also when it is only the derived default: choosing it here records the choice.
    if (next !== mode || settings.mode === undefined) void act(setTidyMode(next), () => (next === "companion" ? "Tidy-ups now use Claude Code." : "Tidy-ups now use your API key."))
  }
  return (
    <section className="wf-settings-section" aria-labelledby="settings-connection">
      <h2 id="settings-connection" className="wf-group-title">Connection</h2>
      <fieldset className="wf-card wf-settings-card wf-mode-choice">
        <legend className="wf-visually-hidden">How Wherefore runs a tidy-up</legend>
        <label className="wf-settings-row">
          <input type="radio" name="wf-mode" checked={mode === "companion"} onChange={() => choose("companion")} />
          <span className="wf-grow wf-stack">
            <span className="wf-strong">Claude Code</span>
            <span className="wf-sub">Uses your Claude Code login, through the Wherefore companion</span>
          </span>
        </label>
        <label className="wf-settings-row wf-settings-divider">
          <input type="radio" name="wf-mode" checked={mode === "api"} onChange={() => choose("api")} />
          <span className="wf-grow wf-stack">
            <span className="wf-strong">Anthropic API key</span>
            <span className="wf-sub">Runs in this browser with your own key</span>
          </span>
        </label>
      </fieldset>
      {mode === "companion" ? <ClaudeCodeCard settings={settings} companion={companion} /> : <ApiKeyCard settings={settings} />}
    </section>
  )
}

/** The labels Settings uses for the agent's settings (canvas v6 says "How carefully to look" for effort). */
const settingLabel = (setting: AgentSetting): string => (setting.category === "thought_level" ? "How carefully to look" : setting.name)

/** The model the agent will use, by name, for the summary line. */
const modelLine = (options: ReadonlyArray<AgentSetting>, settings: SettingsValue): string | undefined => {
  const model = options.find((setting) => setting.category === "model")
  if (model === undefined) return undefined
  const value = shownPref(model, settings.agentPrefs ?? {})
  return model.choices?.find((choice) => choice.value === value)?.name ?? (typeof value === "string" ? value : undefined)
}

function ClaudeCodeCard({ settings, companion }: { readonly settings: SettingsValue; readonly companion: CompanionStatus }) {
  const act = useAct()
  const agentOptions = useAtomValue(agentOptionsAtom)
  const command = agentCommandOf(settings)
  const connected = companion._tag === "Connected"
  const stored: AgentOptions | undefined = AsyncResult.isSuccess(agentOptions) ? agentOptions.value : undefined
  // What this command's agent offered last time; another command's agent offers other settings.
  const offered = stored !== undefined && stored.command === command ? stored.settings : []
  const prefs = settings.agentPrefs ?? {}
  const label = agentLabel(command)
  const model = modelLine(offered, settings)
  return (
    <div className="wf-card wf-settings-card">
      <div className="wf-settings-row">
        <span className={connected ? "wf-dot" : "wf-dot wf-dot-off"} aria-hidden="true" />
        <span className="wf-grow wf-stack">
          <span className="wf-strong">{label === "Claude Code" ? "Claude Code" : "Your agent"}</span>
          <span className="wf-sub">
            {connected
              ? `Uses your Claude Code login${model === undefined ? "" : ` · ${model}`}`
              : "Needs the Wherefore companion (see Companion below)"}
          </span>
        </span>
      </div>
      {connected && offered.length === 0
        ? (
          <p className="wf-settings-row wf-settings-divider wf-sub">
            Model and effort choices appear after your first tidy-up. Until then: Sonnet, medium effort.
          </p>
        )
        : null}
      {connected
        ? offered.map((setting) => (
          <AgentSettingRow
            key={setting.id}
            setting={setting}
            value={shownPref(setting, prefs)}
            onChange={(value) => void act(setAgentPref(setting.id, value), () => `${settingLabel(setting)} saved. It applies from the next tidy-up.`)}
          />
        ))
        : null}
      <AgentCommandRow command={command} />
    </div>
  )
}

function AgentSettingRow(
  { setting, value, onChange }: {
    readonly setting: AgentSetting
    readonly value: string | boolean
    readonly onChange: (value: string | boolean) => void
  }
) {
  const id = `settings-agent-${setting.id}`
  if (setting.choices === undefined) {
    return (
      <label className="wf-settings-row wf-settings-divider" htmlFor={id}>
        <span className="wf-grow">{settingLabel(setting)}</span>
        <input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
      </label>
    )
  }
  return (
    <div className="wf-settings-row wf-settings-divider">
      <label htmlFor={id} className="wf-grow">{settingLabel(setting)}</label>
      <select id={id} className="wf-select" value={String(value)} onChange={(event) => onChange(event.target.value)}>
        {setting.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
      </select>
    </div>
  )
}

/** The agent's command line (advanced): the user's own, or the default. */
function AgentCommandRow({ command }: { readonly command: string }) {
  const act = useAct()
  const [draft, setDraft] = useState(command)
  const [busy, setBusy] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const saved = await act(setAgentCommand(draft), () => "Agent command saved. It applies from the next tidy-up.")
    setBusy(false)
    if (saved._tag === "Some") setDraft(draft.trim() === "" ? DEFAULT_AGENT_COMMAND : draft.trim())
  }
  return (
    <details className="wf-settings-row wf-settings-divider wf-agent-command">
      <summary>Agent command</summary>
      <form className="wf-stack wf-key-form" onSubmit={save}>
        <label className="wf-field">
          <span className="wf-field-label">Command the companion runs</span>
          <input
            className="wf-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="wf-agent-command-help"
          />
        </label>
        <p id="wf-agent-command-help" className="wf-help">
          An ACP agent the companion starts on your computer. Words are split on spaces; quote a path with spaces.
        </p>
        <div className="wf-item-actions">
          <button type="submit" className="wf-button wf-button-small" disabled={busy || draft.trim() === command}>Save</button>
          {command === DEFAULT_AGENT_COMMAND ? null : (
            <button
              type="button"
              className="wf-text-button"
              onClick={async () => {
                setDraft(DEFAULT_AGENT_COMMAND)
                await act(setAgentCommand(""), () => "Back to the default agent command.")
              }}
            >
              Use the default
            </button>
          )}
        </div>
      </form>
    </details>
  )
}

function ApiKeyCard({ settings }: { readonly settings: SettingsValue }) {
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
  )
}

/** What the companion's state means for the user, in one line. */
export const companionLine = (status: CompanionStatus): string => {
  switch (status._tag) {
    case "Checking":
      return "Checking…"
    case "NotInstalled":
      return "Not installed. Claude Code and MCP need it; an API key doesn't."
    case "Connected":
      return `Connected · version ${status.companionVersion}`
    case "Unavailable":
      return status.retryAt === undefined ? status.message : `${status.message} Trying again shortly.`
  }
}

/** The companion's status line, and where to get it when it isn't installed. */
function Companion({ status }: { readonly status: CompanionStatus }) {
  const act = useAct()
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    await act(checkCompanion)
    setBusy(false)
  }
  const canCheck = status._tag === "NotInstalled" || status._tag === "Unavailable"
  return (
    <section className="wf-settings-section" aria-labelledby="settings-companion">
      <h2 id="settings-companion" className="wf-group-title">Companion</h2>
      <div className="wf-card wf-settings-card">
        <div className="wf-settings-row">
          <span className={status._tag === "Connected" ? "wf-dot" : "wf-dot wf-dot-off"} aria-hidden="true" />
          <span className="wf-grow wf-stack">
            <span className="wf-strong">Wherefore companion</span>
            <span className="wf-sub" role="status">{companionLine(status)}</span>
          </span>
          {canCheck
            ? (
              <button type="button" className="wf-button wf-button-small" onClick={check} disabled={busy}>
                Check again
              </button>
            )
            : null}
        </div>
        {status._tag === "NotInstalled"
          ? (
            <p className="wf-settings-row wf-settings-divider wf-sub">
              <a href={COMPANION_README_URL} target="_blank" rel="noreferrer">How to install the companion</a>
            </p>
          )
          : null}
      </div>
    </section>
  )
}

function Usage({ runs, claudeCode }: { readonly runs: ReadonlyArray<Run>; readonly claudeCode: boolean }) {
  const since = startOfWeek(Date.now())
  const thisWeek = runs.filter((run) => DateTime.toEpochMillis(run.startedAt) >= since)
  const cost = thisWeek.reduce((sum, run) => sum + (run.usage.costUsd ?? 0), 0)
  // A cost is shown when a run reported one (API mode always; Claude Code when it says).
  const costed = thisWeek.some((run) => run.usage.costUsd !== undefined)
  return (
    <section className="wf-settings-section" aria-labelledby="settings-usage">
      <h2 id="settings-usage" className="wf-group-title">Usage</h2>
      <div className="wf-card wf-settings-card wf-stack wf-padded">
        <span className="wf-strong">This week: {plural(thisWeek.length, "tidy-up")}</span>
        <span className="wf-sub">
          {costed
            ? `About ${formatUsd(cost)} at Anthropic's list prices.`
            : claudeCode
            ? "Included in your Claude Code plan. With an API key, the cost shows here."
            : thisWeek.length === 0
            ? "Costs show here after a tidy-up."
            : `About ${formatUsd(cost)} at Anthropic's list prices.`}
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
