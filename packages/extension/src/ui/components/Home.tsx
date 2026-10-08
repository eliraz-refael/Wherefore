/**
 * Your list, the home screen (canvas v7 "Main"): search and a chip per tag narrow it; items with a
 * date are "Coming up", soonest first, the rest "Anytime", by tag. Each row has its tag, short
 * title, tabs and sites, its date, and a round Done; expand one for its next step (editable), why,
 * date, tabs (take any of them off it), Open all, Done and Remove. Removals and Done have undo.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { matchSavedTabs, type SavedItem, tagLabel } from "@wherefore/core"
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
import { type DueView, dueView } from "../dates.ts"
import { displayDomain, isWebUrl } from "../format.ts"
import { focusIdSoon, focusSoon, useAct } from "../hooks.ts"
import { listSections, metaLine, openItems, TAG_ORDER, type TagFilter, tagCounts } from "../list.ts"
import {
  CalendarIcon,
  CheckIcon,
  ChevronIcon,
  GearIcon,
  LogoIcon,
  ScreenTitle,
  SearchIcon,
  SiteBadge,
  StoreProblem,
  TabText,
  TagChip
} from "./common.tsx"

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
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<TagFilter>("all")
  const open = openItems(items)
  const doneCount = items.length - open.length
  const nowMs = Date.now()
  const counts = tagCounts(open)
  // A chip goes when its last item does; the list then shows everything again, and stays that way
  // when an item with that tag is saved later (adjusting state while rendering, as React allows).
  if (picked !== "all" && counts[picked] === 0) setPicked("all")
  const filter: TagFilter = picked !== "all" && counts[picked] === 0 ? "all" : picked
  const { comingUp, anytime } = listSections(open, { filter, query })

  const section = (id: string, title: string, group: ReadonlyArray<SavedItem>) =>
    group.length === 0 ? null : (
      <section className="wf-group" aria-labelledby={id}>
        <h2 id={id} className="wf-group-title">{title}</h2>
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
        : (
          <>
            <div className="wf-search">
              <SearchIcon />
              <label htmlFor="wf-search" className="wf-visually-hidden">Search your list</label>
              <input
                id="wf-search"
                type="search"
                className="wf-input wf-search-input"
                placeholder="Search tasks, tabs, sites"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="wf-chips" role="group" aria-label="Show">
              {(["all", ...TAG_ORDER.filter((tag) => counts[tag] > 0)] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className="wf-chip"
                  aria-pressed={filter === key}
                  onClick={() => setPicked(key)}
                >
                  {key === "all" ? "All" : tagLabel[key]}{" "}
                  <span className="wf-chip-count">{key === "all" ? open.length : counts[key]}</span>
                </button>
              ))}
            </div>
            {section("group-coming-up", "Coming up", comingUp)}
            {section("group-anytime", "Anytime", anytime)}
            {comingUp.length === 0 && anytime.length === 0
              ? (
                <p className="wf-muted" role="status">
                  Nothing matches “{query.trim()}”. Search looks at tasks, notes, tab titles and sites.
                </p>
              )
              : null}
          </>
        )}
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

/** An item's date on its row: "Mon 12 Oct", warm when it is soon or past. */
const DuePill = ({ due }: { readonly due: DueView }) => (
  <span className={due.soon ? "wf-date-pill wf-date-soon" : "wf-date-pill"}>
    <CalendarIcon size={12} />
    {due.short}
  </span>
)

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
  const titleId = `item-${item.id}-title`
  const tagId = `item-${item.id}-tag`
  const metaId = `item-${item.id}-meta`
  const due = item.due === undefined ? undefined : dueView(item.due, props.nowMs)
  const source = item.due?.source.trim() ?? ""

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
    <article className={expanded ? "wf-card wf-item wf-item-open" : "wf-card wf-item"} aria-labelledby={titleId}>
      <div className="wf-list-row">
        <button
          type="button"
          className="wf-check"
          aria-label={`Mark done: ${item.title}`}
          onClick={() => leave(markItemDone(item))}
          disabled={busy}
        >
          <span className="wf-check-ring"><CheckIcon size={12} /></span>
        </button>
        <button
          type="button"
          className="wf-list-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-labelledby={titleId}
          aria-describedby={`${tagId} ${metaId}`}
          onClick={props.onToggle}
          data-item-toggle={item.id}
        >
          <span className="wf-list-head">
            <span className="wf-list-line">
              <TagChip tag={item.tag} id={tagId} />
              <span id={titleId} className="wf-list-title">{item.title}</span>
            </span>
            <span id={metaId} className="wf-list-meta">
              <span className="wf-list-sites">{metaLine(item)}</span>
              {due === undefined ? null : <DuePill due={due} />}
            </span>
          </span>
          <ChevronIcon open={expanded} />
        </button>
      </div>
      {expanded
        ? (
          <div id={detailsId} className="wf-list-details">
            {editing
              ? <EditTask item={item} onClose={() => props.onEdit(false)} />
              : (
                <div className="wf-next">
                  <p className="wf-next-step">{item.task}</p>
                  <button type="button" className="wf-text-button" onClick={() => props.onEdit(true)}>Edit</button>
                </div>
              )}
            {item.why === "" ? null : <p className="wf-why">{item.why}</p>}
            {due === undefined ? null : (
              <div className={due.soon ? "wf-datebox wf-datebox-soon" : "wf-datebox"}>
                <CalendarIcon />
                <div className="wf-stack">
                  <span className="wf-datebox-when">{due.long}</span>
                  {source === "" ? null : <span className="wf-datebox-source">{source}</span>}
                </div>
              </div>
            )}
            <TabLinks tabs={item.tabs} remove={{ idPrefix: removeIdPrefix, busy, onRemove: dropTab }} />
            <div className="wf-list-actions">
              <button
                type="button"
                className="wf-primary wf-primary-small"
                onClick={() => act(openItem(item), (message) => message)}
                disabled={busy}
              >
                {item.tabs.length === 1 ? "Open" : `Open all ${item.tabs.length}`}
              </button>
              <button type="button" className="wf-button" onClick={() => leave(markItemDone(item))} disabled={busy}>
                Done
              </button>
              <span className="wf-grow" />
              <button type="button" className="wf-text-button" onClick={() => leave(removeItem(item))} disabled={busy}>
                Remove
              </button>
            </div>
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
        <span className="wf-field-label">Next step</span>
        <input ref={input} className="wf-input" value={task} onChange={(event) => setTask(event.target.value)} />
      </label>
      <div className="wf-item-actions">
        <button type="submit" className="wf-button wf-button-small" disabled={busy || task.trim() === ""}>Save</button>
        <button type="button" className="wf-text-button" onClick={close}>Cancel</button>
      </div>
    </form>
  )
}
