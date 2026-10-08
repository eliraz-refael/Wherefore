/**
 * Your list, the home screen (canvas v6 "Main"): open items grouped by type, each with Done and
 * Open; expand one to see its tabs (title + domain) and take any of them off it, edit its task, or
 * remove it. Removals have undo.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { matchSavedTabs, type SavedItem, type TrackerType, trackerTypeLabel } from "@wherefore/core"
import { DateTime } from "effect"
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react"
import { AsyncResult } from "../../unstable.ts"
import {
  type Done,
  editTask,
  markItemDone,
  openItem,
  type PanelEffect,
  removeItem,
  removeTab,
  resetStoreKey,
  startTidy
} from "../actions.ts"
import { itemsAtom, openTabsAtom, runsAtom, screenAtom } from "../atoms.ts"
import { displayDomain, isWebUrl, tabCount, whenLabel } from "../format.ts"
import { focusIdSoon, focusSoon, useAct } from "../hooks.ts"
import { CheckIcon, GearIcon, LogoIcon, ScreenTitle, SiteBadge, StoreProblem, TabText } from "./common.tsx"

export const TYPE_ORDER: ReadonlyArray<TrackerType> = ["todo", "follow_up", "read", "keep"]

const newestFirst = (a: SavedItem, b: SavedItem) => DateTime.toEpochMillis(b.savedAt) - DateTime.toEpochMillis(a.savedAt)

/** Starts a tidy-up (or joins the one running elsewhere) and shows it. */
export const useStartTidy = () => {
  const act = useAct()
  const setScreen = useAtomSet(screenAtom)
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    const started = await act(startTidy)
    setBusy(false)
    if (started._tag === "Some") setScreen({ name: "tidy", runId: started.value })
  }
  return { busy, start }
}

export function Home() {
  const items = useAtomValue(itemsAtom)
  const setScreen = useAtomSet(screenAtom)
  return (
    <div className="wf-screen">
      <header className="wf-header">
        <LogoIcon />
        <span className="wf-brand-name wf-grow">Wherefore</span>
        <button type="button" className="wf-icon-button" aria-label="Settings" onClick={() => setScreen({ name: "settings" })}>
          <GearIcon />
        </button>
      </header>
      <TidyBand />
      <main className="wf-main">
        {AsyncResult.match(items, {
          onInitial: () => <p className="wf-muted">Loading your list…</p>,
          onFailure: () => <ListProblem />,
          onSuccess: ({ value }) => <YourList items={value} />
        })}
      </main>
    </div>
  )
}

function ListProblem() {
  const act = useAct()
  const [busy, setBusy] = useState(false)
  const reset = async () => {
    setBusy(true)
    await act(resetStoreKey("items"), () => "Started a fresh list. The old one is kept in storage.")
    setBusy(false)
  }
  return (
    <>
      <ScreenTitle>Your list</ScreenTitle>
      <StoreProblem what="Your list" onReset={reset} busy={busy} />
    </>
  )
}

/** The blue band: Tidy up, or the tidy-up that is running or waiting for review. */
function TidyBand() {
  const runs = useAtomValue(runsAtom)
  const items = useAtomValue(itemsAtom)
  const openTabs = useAtomValue(openTabsAtom)
  const setScreen = useAtomSet(screenAtom)
  const { busy, start } = useStartTidy()
  const newest = AsyncResult.isSuccess(runs) ? runs.value.runs.at(-1) : undefined

  let text: string
  let action = (
    <button type="button" className="wf-primary wf-primary-small" onClick={start} disabled={busy}>
      Tidy up
    </button>
  )
  if (newest?.status === "running") {
    text = "Tidying up…"
    action = (
      <button type="button" className="wf-primary wf-primary-small" onClick={() => setScreen({ name: "tidy", runId: newest.id })}>
        Show
      </button>
    )
  } else if (newest?.status === "succeeded" && newest.reviewedAt === undefined && newest.intentions.length > 0) {
    text = "Your tidy-up is ready"
    action = (
      <>
        <button type="button" className="wf-text-button wf-band-secondary" onClick={start} disabled={busy}>
          Start over
        </button>
        <button type="button" className="wf-primary wf-primary-small" onClick={() => setScreen({ name: "tidy", runId: newest.id })}>
          Review
        </button>
      </>
    )
  } else if (AsyncResult.isSuccess(openTabs) && AsyncResult.isSuccess(items)) {
    const loose = matchSavedTabs(openTabs.value, items.value).unsaved.length
    text = loose === 1 ? "1 open tab isn't on your list" : `${loose} open tabs aren't on your list`
  } else {
    text = "Turn your open tabs into a short list"
  }
  return (
    <section className="wf-band" aria-label="Tidy up">
      <span className="wf-band-text">{text}</span>
      {action}
    </section>
  )
}

function YourList({ items }: { readonly items: ReadonlyArray<SavedItem> }) {
  const setScreen = useAtomSet(screenAtom)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const open = items.filter((item) => item.status === "open").sort(newestFirst)
  const doneCount = items.length - open.length
  const nowMs = Date.now()

  return (
    <>
      <ScreenTitle>
        {open.length === 0
          ? "Your list is empty"
          : `${open.length} ${open.length === 1 ? "thing" : "things"} you meant to do`}
      </ScreenTitle>
      {open.length === 0
        ? (
          <p className="wf-muted">
            Tidy up looks at your open tabs and writes down what each group was for, so the tabs can close. What you
            save shows up here.
          </p>
        )
        : null}
      {TYPE_ORDER.map((type) => {
        const group = open.filter((item) => item.type === type)
        if (group.length === 0) return null
        return (
          <section key={type} className="wf-group" aria-labelledby={`group-${type}`}>
            <h2 id={`group-${type}`} className="wf-group-title">{trackerTypeLabel[type]}</h2>
            {group.map((item) => (
              <ListItem
                key={item.id}
                item={item}
                nowMs={nowMs}
                expanded={expanded === item.id}
                editing={editing === item.id}
                onToggle={() => {
                  setExpanded(expanded === item.id ? null : item.id)
                  setEditing(null)
                }}
                onEdit={(on) => setEditing(on ? item.id : null)}
              />
            ))}
          </section>
        )
      })}
      <div className="wf-list-footer">
        <button type="button" className="wf-quiet-link" onClick={() => setScreen({ name: "done" })}>
          Done · {doneCount} <span aria-hidden="true">›</span>
        </button>
      </div>
    </>
  )
}

/**
 * Where focus goes when an item leaves the list: the next item, else the screen title. Read it
 * while the item is still rendered.
 */
const focusAfterLeaving = (id: string): string => {
  const toggles = [...document.querySelectorAll<HTMLElement>("[data-item-toggle]")]
  const index = toggles.findIndex((toggle) => toggle.dataset.itemToggle === id)
  const next = toggles[index + 1] ?? toggles[index - 1]
  return next === undefined ? "[data-screen-heading]" : `[data-item-toggle="${next.dataset.itemToggle}"]`
}

function ListItem(props: {
  readonly item: SavedItem
  readonly nowMs: number
  readonly expanded: boolean
  readonly editing: boolean
  readonly onToggle: () => void
  readonly onEdit: (on: boolean) => void
}) {
  const { item, expanded, editing } = props
  const act = useAct()
  const [busy, setBusy] = useState(false)
  const detailsId = `item-${item.id}-details`
  const taskId = `item-${item.id}-task`

  const leave = async <E,>(action: PanelEffect<Done, E>) => {
    setBusy(true)
    focusSoon(focusAfterLeaving(item.id))
    const done = await act(action, (result) => result)
    if (done._tag === "None") setBusy(false)
  }

  // Focus moves on to the next tab's ×, else the previous one's; when the worker says the item went
  // with its last tab, it moves on as if the item had left. A failure keeps focus on this ×.
  const removeIdPrefix = `${detailsId}-remove-`
  const dropTab = async (index: number) => {
    const tab = item.tabs[index]
    if (tab === undefined) return
    const keys = tabKeys(item.tabs)
    const afterLeaving = focusAfterLeaving(item.id)
    setBusy(true)
    const done = await act(removeTab(item, tab, index), (result) => result)
    if (done._tag === "Some" && done.value.removal._tag === "ItemRemoved") return focusSoon(afterLeaving)
    setBusy(false)
    if (done._tag === "None") return focusIdSoon(`${removeIdPrefix}${keys[index]}`)
    // Keys of what is left: a second copy of a URL becomes the first.
    const rest = tabKeys(item.tabs.filter((_, i) => i !== index))
    const next = rest[Math.min(index, rest.length - 1)]
    if (next !== undefined) focusIdSoon(`${removeIdPrefix}${next}`)
  }

  return (
    <article className={expanded ? "wf-card wf-item wf-item-open" : "wf-card wf-item"} aria-labelledby={taskId}>
      <div className="wf-item-row">
        <button
          type="button"
          className="wf-item-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={props.onToggle}
          data-item-toggle={item.id}
        >
          <span id={taskId} className="wf-item-task">{item.task}</span>
          <span className="wf-item-meta">{tabCount(item.tabs.length)} · saved {whenLabel(item.savedAt, props.nowMs)}</span>
        </button>
        <button
          type="button"
          className="wf-done-button"
          aria-label={`Done: ${item.task}`}
          onClick={() => leave(markItemDone(item))}
          disabled={busy}
        >
          <CheckIcon />
          Done
        </button>
        <button
          type="button"
          className="wf-button wf-button-small"
          aria-label={`Open: ${item.task}`}
          onClick={() => act(openItem(item), (message) => message)}
          disabled={busy}
        >
          Open
        </button>
      </div>
      {expanded
        ? (
          <div id={detailsId} className="wf-item-details">
            <TabLinks tabs={item.tabs} remove={{ idPrefix: removeIdPrefix, busy, onRemove: dropTab }} />
            {editing
              ? <EditTask item={item} onClose={() => props.onEdit(false)} />
              : (
                <div className="wf-item-actions">
                  <button type="button" className="wf-text-button" onClick={() => props.onEdit(true)}>Edit</button>
                  <button type="button" className="wf-text-button" onClick={() => leave(removeItem(item))} disabled={busy}>
                    Remove from list
                  </button>
                </div>
              )}
          </div>
        )
        : null}
    </article>
  )
}

/**
 * Each tab's key: its URL, and which copy of that URL it is. It stays the same when another tab is
 * removed, so focus can move to a tab's × once the list has changed.
 */
const tabKeys = (tabs: SavedItem["tabs"]): ReadonlyArray<string> => {
  const seen = new Map<string, number>()
  return tabs.map((tab) => {
    const copy = seen.get(tab.url) ?? 0
    seen.set(tab.url, copy + 1)
    return `${copy}:${tab.url}`
  })
}

/**
 * A saved item's tabs: title and domain; web pages open in a new tab. With `remove`, each tab has
 * a × that takes it off the item (the archive shows tabs without one).
 */
export function TabLinks({ tabs, remove }: {
  readonly tabs: SavedItem["tabs"]
  readonly remove?: {
    /** The ×'s element id is this plus the tab's key. */
    readonly idPrefix: string
    readonly busy: boolean
    readonly onRemove: (index: number) => void
  }
}) {
  const keys = tabKeys(tabs)
  return (
    <ul className="wf-tabs">
      {tabs.map((tab, index) => {
        const domain = tab.domain === "" ? displayDomain(tab.url) : tab.domain
        const body = (
          <>
            <SiteBadge domain={domain} />
            <TabText title={tab.title} domain={domain} />
          </>
        )
        return (
          <li key={keys[index]} className={remove === undefined ? undefined : "wf-tab-row"}>
            {isWebUrl(tab.url)
              ? <a className="wf-tab" href={tab.url} target="_blank" rel="noreferrer" title="Open this tab">{body}</a>
              : <span className="wf-tab">{body}</span>}
            {remove === undefined ? null : (
              <button
                type="button"
                id={`${remove.idPrefix}${keys[index]}`}
                className="wf-tab-remove"
                aria-label={`Remove ${tab.title === "" ? domain : tab.title}`}
                title="Remove from this item"
                onClick={() => remove.onRemove(index)}
                disabled={remove.busy}
              >
                ×
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function EditTask({ item, onClose }: { readonly item: SavedItem; readonly onClose: () => void }) {
  const [task, setTask] = useState(item.task)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const act = useAct()
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const close = () => {
    onClose()
    focusSoon(`[data-item-toggle="${item.id}"]`)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (task.trim() === "" || task.trim() === item.task) return close()
    setBusy(true)
    const saved = await act(editTask(item, task))
    setBusy(false)
    if (saved._tag === "Some") close()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  }

  return (
    <form className="wf-edit" onSubmit={save} onKeyDown={onKeyDown}>
      <label className="wf-field">
        <span className="wf-field-label">Task</span>
        <input ref={input} className="wf-input" value={task} onChange={(event) => setTask(event.target.value)} />
      </label>
      <div className="wf-item-actions">
        <button type="submit" className="wf-button wf-button-small" disabled={busy || task.trim() === ""}>Save</button>
        <button type="button" className="wf-text-button" onClick={close}>Cancel</button>
      </div>
    </form>
  )
}
