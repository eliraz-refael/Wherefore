/**
 * The Done archive (canvas v6 "Done"): finished items, newest first, by week, each with its tabs
 * (title + domain) and when it was done. Open brings its tabs back as a group; an item can also go
 * back on the list.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type SavedItem } from "@wherefore/core"
import { DateTime } from "effect"
import { useState } from "react"
import { AsyncResult } from "../../unstable.ts"
import { openItem, putBack } from "../actions.ts"
import { itemsAtom, screenAtom } from "../atoms.ts"
import { tabCount, weekBucket, whenLabel } from "../format.ts"
import { focusSoon, useAct } from "../hooks.ts"
import { CheckIcon, SubHeader } from "./common.tsx"
import { TabLinks } from "./Home.tsx"

const BUCKETS = ["This week", "Last week", "Earlier"] as const

const doneMs = (item: SavedItem) => (item.doneAt === undefined ? 0 : DateTime.toEpochMillis(item.doneAt))

export function DoneArchive() {
  const items = useAtomValue(itemsAtom)
  const setScreen = useAtomSet(screenAtom)
  return (
    <div className="wf-screen">
      <SubHeader title="Done" onBack={() => setScreen({ name: "home" })} />
      <main className="wf-main">
        <p className="wf-muted">Things you finished. Their tabs are kept here in case you need them again.</p>
        {AsyncResult.match(items, {
          onInitial: () => <p className="wf-muted">Loading…</p>,
          onFailure: () => <p className="wf-muted">Your list couldn't be read. Settings has a way to start fresh.</p>,
          onSuccess: ({ value }) => <Archive items={value.filter((item) => item.status === "done")} />
        })}
        <p className="wf-fine">Things you remove from your list aren’t kept.</p>
      </main>
    </div>
  )
}

function Archive({ items }: { readonly items: ReadonlyArray<SavedItem> }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const nowMs = Date.now()
  const sorted = [...items].sort((a, b) => doneMs(b) - doneMs(a))
  if (sorted.length === 0) return <p className="wf-card wf-note">Nothing here yet. Items you mark Done land here.</p>
  return (
    <>
      {BUCKETS.map((bucket) => {
        const group = sorted.filter((item) => item.doneAt !== undefined && weekBucket(item.doneAt, nowMs) === bucket)
        if (group.length === 0) return null
        const headingId = `done-${bucket.replace(" ", "-").toLowerCase()}`
        return (
          <section key={bucket} className="wf-group" aria-labelledby={headingId}>
            <h2 id={headingId} className="wf-group-title">{bucket}</h2>
            {group.map((item) => (
              <DoneItem
                key={item.id}
                item={item}
                nowMs={nowMs}
                expanded={expanded === item.id}
                onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
              />
            ))}
          </section>
        )
      })}
    </>
  )
}

function DoneItem(
  { item, nowMs, expanded, onToggle }: {
    readonly item: SavedItem
    readonly nowMs: number
    readonly expanded: boolean
    readonly onToggle: () => void
  }
) {
  const act = useAct()
  const detailsId = `done-${item.id}-details`
  const when = item.doneAt === undefined ? "" : ` · done ${whenLabel(item.doneAt, nowMs)}`
  return (
    <article className="wf-card wf-item wf-done-item">
      <div className="wf-item-row">
        <span className="wf-done-check"><CheckIcon size={18} /></span>
        <button
          type="button"
          className="wf-item-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggle}
          data-item-toggle={item.id}
        >
          <span className="wf-item-task">{item.task}</span>
          <span className="wf-item-meta">{tabCount(item.tabs.length)}{when}</span>
        </button>
        <button
          type="button"
          className="wf-button wf-button-small"
          aria-label={`Open: ${item.task}`}
          onClick={() => act(openItem(item), (message) => message)}
        >
          Open
        </button>
      </div>
      {expanded
        ? (
          <div id={detailsId} className="wf-item-details">
            <TabLinks tabs={item.tabs} />
            <div className="wf-item-actions">
              <button
                type="button"
                className="wf-text-button"
                onClick={() => {
                  focusSoon("[data-screen-heading]")
                  void act(putBack(item), () => `“${item.task}” is back on your list.`)
                }}
              >
                Put back on your list
              </button>
            </div>
          </div>
        )
        : null}
    </article>
  )
}
