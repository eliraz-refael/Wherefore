/**
 * Tidy up, results (canvas v6 "Review"): what each group of tabs was for, ready to save with smart
 * defaults, each with its tag and short title. Each result expands to edit its task and type, read the one-line why and see its tabs.
 * Below: what closes (finished, leftovers, already on the list) and what stays open (everyday
 * apps). The sticky bar saves and closes everything at once, with undo.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Run, savedTitle } from "@wherefore/core"
import { useState } from "react"
import { AsyncResult } from "../../unstable.ts"
import { saveAndClose, saveOne, updateChoice } from "../actions.ts"
import { choicesAtom, itemsAtom, openTabsAtom, remapAtom, screenAtom } from "../atoms.ts"
import { type ListSection, SECTION_ORDER, sectionLabel, sectionOf, tabCount, tagIn } from "../format.ts"
import { focusIdSoon, useAct } from "../hooks.ts"
import {
  buildReview,
  type Choices,
  closable,
  namesOf,
  planOf,
  type ResultChoice,
  type ReviewModel,
  type ReviewResult,
  type ReviewTab,
  saveBarLabel,
  tagOf,
  taskOf
} from "../review.ts"
import { ChevronIcon, SiteBadge, SubHeader, TabText, TagChip } from "./common.tsx"

/** Results shown before "+ N more". */
export const RESULTS_SHOWN = 12

export function Review({ run, onBack }: { readonly run: Run; readonly onBack: () => void }) {
  const items = useAtomValue(itemsAtom)
  const openTabs = useAtomValue(openTabsAtom)
  const remap = useAtomValue(remapAtom)
  const choices = useAtomValue(choicesAtom(run.id))

  if (!AsyncResult.isSuccess(items) || !AsyncResult.isSuccess(openTabs)) {
    return (
      <div className="wf-screen">
        <SubHeader title="Here’s what your tabs were for" onBack={onBack} />
        <main className="wf-main">
          <p className="wf-muted" role="status">
            {AsyncResult.isFailure(items) ? "Your list couldn't be read. Settings has a way to start fresh." : "Loading…"}
          </p>
        </main>
      </div>
    )
  }
  const model = buildReview({ run, openTabs: openTabs.value, items: items.value, remap })
  return <ReviewBody run={run} model={model} choices={choices} onBack={onBack} />
}

function ReviewBody(
  { run, model, choices, onBack }: {
    readonly run: Run
    readonly model: ReviewModel
    readonly choices: Choices
    readonly onBack: () => void
  }
) {
  const act = useAct()
  const setScreen = useAtomSet(screenAtom)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const plan = planOf(model, choices)

  const sectionOfResult = (result: ReviewResult) => sectionOf(tagOf(result, choices[result.intention.id]))
  const ordered = SECTION_ORDER.flatMap((section) => model.results.filter((result) => sectionOfResult(result) === section))
  const visible = new Set((showAll ? ordered : ordered.slice(0, RESULTS_SHOWN)).map((result) => result.intention.id))
  const hidden = ordered.length - visible.size

  const save = async () => {
    setBusy(true)
    const done = await act(saveAndClose(run, model), (result) => result)
    setBusy(false)
    if (done._tag === "Some") setScreen({ name: "home" })
  }

  const nothing = model.results.length === 0 && plan.close.length === 0

  return (
    <div className="wf-screen">
      <SubHeader title="Here’s what your tabs were for" onBack={onBack} />
      <main className="wf-main wf-main-review">
        {nothing
          ? <p className="wf-card wf-note">Nothing to tidy: your tabs are on your list already, or in everyday use.</p>
          : null}
        {SECTION_ORDER.map((section) => {
          const group = ordered.filter((result) => visible.has(result.intention.id) && sectionOfResult(result) === section)
          if (group.length === 0) return null
          return (
            <section key={section} className="wf-group" aria-labelledby={`review-${section}`}>
              <h2 id={`review-${section}`} className="wf-group-title">{sectionLabel[section]}</h2>
              {group.map((result) => (
                <ResultCard
                  key={result.intention.id}
                  run={run}
                  result={result}
                  choice={choices[result.intention.id]}
                  expanded={expanded === result.intention.id}
                  onToggle={() => setExpanded(expanded === result.intention.id ? null : result.intention.id)}
                />
              ))}
            </section>
          )
        })}
        {hidden > 0
          ? (
            <button type="button" className="wf-text-button wf-more" onClick={() => setShowAll(true)}>
              + {hidden} more
            </button>
          )
          : null}
        <ClosingSummary model={model} plan={plan} />
      </main>
      <footer className="wf-savebar">
        <button type="button" className="wf-primary" onClick={save} disabled={busy}>
          {saveBarLabel(plan)}
        </button>
        <span className="wf-savebar-note">Nothing is lost. You can undo.</span>
      </footer>
    </div>
  )
}

function ResultCard(props: {
  readonly run: Run
  readonly result: ReviewResult
  readonly choice: ResultChoice | undefined
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  const { run, result, choice, expanded } = props
  const act = useAct()
  const id = result.intention.id
  const detailsId = `result-${id}-details`
  const typeSelectId = `result-${id}-type`
  const titleId = `result-${id}-title`
  const tagId = `result-${id}-tag`
  const subId = `result-${id}-sub`
  const countId = `result-${id}-count`
  const saved = choice?.savedAs !== undefined
  const kept = choice?.keepOpen === true
  const task = taskOf(result, choice)
  const title = savedTitle(result.intention)
  const count = result.tabs.length
  const meta = saved ? "Saved" : kept ? "Keeping open" : undefined

  const [saving, setSaving] = useState(false)

  const change = (patch: ResultChoice) => act(updateChoice(run, result, patch))
  const saveJustThis = async () => {
    // One save per click: a second click before `savedAs` is set would save a duplicate item.
    if (saving) return
    setSaving(true)
    await act(saveOne(run, result), (done) => done)
    setSaving(false)
  }

  return (
    <article className={expanded ? "wf-card wf-result wf-result-open" : "wf-card wf-result"}>
      <button
        type="button"
        className="wf-result-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-labelledby={titleId}
        aria-describedby={`${tagId} ${subId} ${countId}`}
        onClick={props.onToggle}
      >
        <span className="wf-result-heading">
          <span className="wf-result-line">
            <TagChip tag={tagOf(result, choice)} id={tagId} />
            <span id={titleId} className="wf-result-title">{title}</span>
          </span>
          <span id={subId} className="wf-result-lines">
            {task === title ? null : <span className="wf-result-task">{task}</span>}
            {result.unsure && !saved ? <span className="wf-unsure">Not sure</span> : null}
            {meta === undefined ? null : <span className="wf-result-meta">{meta}</span>}
          </span>
        </span>
        <span id={countId} className="wf-result-count" aria-label={tabCount(count)}>{count}</span>
        <ChevronIcon open={expanded} />
      </button>
      {expanded
        ? (
          <div id={detailsId} className="wf-result-details">
            {saved
              ? <p className="wf-muted">Saved to your list.</p>
              : (
                <>
                  <label className="wf-field">
                    <span className="wf-field-label">Save as</span>
                    <input
                      className="wf-input wf-input-strong"
                      value={choice?.task ?? task}
                      onChange={(event) => change({ task: event.target.value })}
                    />
                  </label>
                  <label className="wf-field wf-field-inline">
                    <span className="wf-field-label">Under</span>
                    <select
                      id={typeSelectId}
                      className="wf-select"
                      value={sectionOf(tagOf(result, choice))}
                      onChange={(event) => {
                        change({ tag: tagIn(event.target.value as ListSection, result.tag) })
                        // The card moves to its new group: keep the focus on this select.
                        focusIdSoon(typeSelectId)
                      }}
                    >
                      {SECTION_ORDER.map((section) => <option key={section} value={section}>{sectionLabel[section]}</option>)}
                    </select>
                  </label>
                </>
              )}
            {result.intention.why === "" ? null : <p className="wf-why">{result.intention.why}</p>}
            <ReviewTabs tabs={result.tabs} />
            {saved
              ? null
              : (
                <div className="wf-result-actions">
                  <button type="button" className="wf-link-button" onClick={() => change({ keepOpen: !kept })}>
                    {kept ? "Save these tabs instead" : "Keep these tabs open"}
                  </button>
                  {kept ? null : (
                    <button type="button" className="wf-link-button" onClick={saveJustThis} disabled={saving}>
                      Save just this
                    </button>
                  )}
                </div>
              )}
          </div>
        )
        : null}
    </article>
  )
}

function ReviewTabs({ tabs }: { readonly tabs: ReadonlyArray<ReviewTab> }) {
  return (
    <ul className="wf-tabs wf-tabs-plain">
      {tabs.map((tab) => (
        <li key={tab.id} className="wf-tab">
          <SiteBadge domain={tab.domain} />
          <TabText title={tab.title} domain={tab.open ? tab.domain : `${tab.domain} · closed`} />
        </li>
      ))}
    </ul>
  )
}

function ClosingSummary({ model, plan }: { readonly model: ReviewModel; readonly plan: ReturnType<typeof planOf> }) {
  const [open, setOpen] = useState(false)
  const finished = closable(model.finished.tabs).length
  const leftovers = closable(model.leftovers.tabs).length
  const onList = closable(model.onList.tabs).length
  const closing = finished + leftovers + onList
  const appNames = model.apps.tabs.map((tab) => tab.domain)
  const keptNames = plan.leftOpen.filter((tab) => !model.apps.tabs.includes(tab)).map((tab) => tab.domain)

  if (closing === 0 && plan.leftOpen.length === 0) return null
  return (
    <section className="wf-closing" aria-label="Closing and left open">
      {closing === 0 ? null : (
        <article className="wf-card wf-result">
          <button
            type="button"
            className="wf-result-toggle"
            aria-expanded={open}
            aria-controls="wf-closing-details"
            onClick={() => setOpen(!open)}
          >
            <span className="wf-result-heading">
              <span className="wf-result-task">Close · {tabCount(closing)}</span>
              <span className="wf-result-sub">Finished, leftovers, already on your list</span>
            </span>
            <ChevronIcon open={open} />
          </button>
          {open
            ? (
              <ul id="wf-closing-details" className="wf-closing-list">
                {finished === 0 ? null : (
                  <li>
                    <span className="wf-closing-name">Finished · {tabCount(finished)}</span>
                    <span className="wf-result-sub">{namesOf(model.finished.intentions.map((i) => i.title), 2)}</span>
                  </li>
                )}
                {leftovers === 0 ? null : (
                  <li>
                    <span className="wf-closing-name">Leftovers · {tabCount(leftovers)}</span>
                    <span className="wf-result-sub">Sign-in pages, error pages and duplicates</span>
                  </li>
                )}
                {onList === 0 ? null : (
                  <li>
                    <span className="wf-closing-name">Already on your list · {tabCount(onList)}</span>
                    <span className="wf-result-sub">{namesOf(model.onList.items.map((item) => item.task))}</span>
                  </li>
                )}
              </ul>
            )
            : null}
        </article>
      )}
      {plan.leftOpen.length === 0 ? null : (
        <article className="wf-card wf-left-open">
          <span className="wf-result-task">Left open · {tabCount(plan.leftOpen.length)}</span>
          <span className="wf-result-sub">
            {namesOf([...appNames, ...keptNames])}
            {keptNames.length === 0 ? " you use every day" : ""}
          </span>
        </article>
      )}
    </section>
  )
}
