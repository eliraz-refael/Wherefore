/**
 * Tidy up: one screen for a run, whichever page runs it. While it runs: a plain-language status
 * and its questions, one at a time, answered with a tap (canvas v6 "Tidying"). When it succeeds:
 * the results (Review.tsx). When it stops: why, and a way to start again.
 *
 * The run comes from the Store (`runsAtom`), so another open panel shows the same run, its
 * questions and its Stop button; `Tidy` passes answers and Stop to the page that owns the run.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Answer, QuestionStep, Run, RunId } from "@wherefore/core"
import { Option } from "effect"
import { useState } from "react"
import { AsyncResult } from "../../unstable.ts"
import { answerAsk, showTab, stopRun } from "../actions.ts"
import { runsAtom, screenAtom } from "../atoms.ts"
import { agentName, displayDomain } from "../format.ts"
import { focusIdSoon, useAct, useToast } from "../hooks.ts"
import { progressText } from "../progress.ts"
import { pendingAsk } from "../Tidy.ts"
import { BackButton, ScreenTitle, SiteBadge, SubHeader, TabText } from "./common.tsx"
import { useStartTidy } from "./Home.tsx"
import { Review } from "./Review.tsx"

/** What a user taps when they don't know: the agent hears it and leaves the tabs alone. */
export const NOT_SURE = "Not sure, leave it open"

export function TidyScreen({ runId }: { readonly runId: RunId }) {
  const runs = useAtomValue(runsAtom)
  const setScreen = useAtomSet(screenAtom)
  const back = () => setScreen({ name: "home" })
  const run = AsyncResult.isSuccess(runs) ? runs.value.runs.find((candidate) => candidate.id === runId) : undefined

  if (run === undefined) {
    return (
      <div className="wf-screen">
        <SubHeader title="Tidying up" onBack={back} />
        <main className="wf-main">
          <p className="wf-muted" role="status">
            {AsyncResult.isFailure(runs) ? "Tidy-ups couldn't be read. Settings has a way to start fresh." : "Getting started…"}
          </p>
        </main>
      </div>
    )
  }
  switch (run.status) {
    case "running":
      return <Working run={run} onBack={back} />
    case "succeeded":
      return <Review run={run} onBack={back} />
    default:
      return <Stopped run={run} onBack={back} />
  }
}

function Working({ run, onBack }: { readonly run: Run; readonly onBack: () => void }) {
  const act = useAct()
  const [stopping, setStopping] = useState(false)
  const ask = pendingAsk(run)
  const stop = async () => {
    setStopping(true)
    await act(stopRun(run))
    setStopping(false)
  }
  return (
    <div className="wf-screen">
      <header className="wf-header wf-header-stacked">
        <div className="wf-header-row">
          <BackButton onBack={onBack} />
          <ScreenTitle className="wf-header-title">Tidying up</ScreenTitle>
          <button type="button" className="wf-button wf-button-small" onClick={stop} disabled={stopping}>
            Stop
          </button>
        </div>
        <progress className="wf-progress" aria-label="Tidy-up progress" />
        <p className="wf-progress-text" role="status">{progressText(run)}</p>
      </header>
      <main className="wf-main">
        {Option.match(ask, {
          onNone: () => (
            <p className="wf-card wf-note">
              {run.mode === "api" ? "This takes a minute or two." : `${agentName(run.agent)} is working through your tabs.`}{" "}
              You can keep browsing; your tabs stay where they are until you save.
            </p>
          ),
          onSome: (step) => <QuestionCard key={step.callId} run={run} step={step} />
        })}
      </main>
    </div>
  )
}

/**
 * One ask's questions, one at a time. The answers go together once the last one is tapped; the
 * first answer to reach the run wins, from whichever panel.
 */
function QuestionCard({ run, step }: { readonly run: Run; readonly step: QuestionStep }) {
  const act = useAct()
  const toast = useToast()
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<ReadonlyArray<Answer>>([])
  const [sent, setSent] = useState(false)
  const question = step.questions[index]
  const tabsById = new Map(run.tabs.map((tab) => [tab.id, tab]))
  const headingId = `question-${step.callId}-${index}`

  if (sent || question === undefined) {
    return <p className="wf-card wf-note" role="status">Thanks. Back to work…</p>
  }

  const pick = async (answer: string) => {
    const given = [...answers, { id: question.id, answer }]
    if (index + 1 < step.questions.length) {
      setAnswers(given)
      setIndex(index + 1)
      focusIdSoon(`question-${step.callId}-${index + 1}`)
      return
    }
    setSent(true)
    const accepted = await act(answerAsk(run, step.callId, given))
    if (accepted._tag === "Some" && accepted.value) return
    if (accepted._tag === "Some") toast("That question was already answered, or its tidy-up stopped.")
    // Not taken (failed, timed out, or refused): offer the questions again. If the ask was answered
    // elsewhere or its run stopped, the stored run moves on and this card goes away by itself.
    setAnswers([])
    setIndex(0)
    setSent(false)
  }

  return (
    <section className="wf-card wf-question" aria-labelledby={headingId}>
      {step.questions.length > 1
        ? <span className="wf-question-position">Question {index + 1} of {step.questions.length}</span>
        : null}
      <h2 id={headingId} className="wf-question-text" tabIndex={-1}>{question.question}</h2>
      <ul className="wf-question-tabs">
        {question.tabIds.map((id) => {
          const tab = tabsById.get(id)
          const domain = displayDomain(tab?.url ?? "")
          const title = tab?.title ?? "A tab"
          return (
            <li key={id} className="wf-question-tab">
              <SiteBadge domain={domain} />
              <TabText title={title} domain={domain} />
              <button
                type="button"
                className="wf-show-me"
                aria-label={`Show me: ${title}`}
                onClick={() => act(showTab(id), (shown) => (shown ? undefined : "That tab is closed now."))}
              >
                Show me <span aria-hidden="true">→</span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="wf-answers">
        {question.options.map((option) => (
          <button key={option} type="button" className="wf-answer" onClick={() => pick(option)}>
            {option}
          </button>
        ))}
      </div>
      <button type="button" className="wf-text-button" onClick={() => pick(NOT_SURE)}>
        {NOT_SURE}
      </button>
    </section>
  )
}

const STOPPED_TITLE: Record<Exclude<Run["status"], "running" | "succeeded">, string> = {
  cancelled: "You stopped this tidy-up",
  failed: "This tidy-up didn't finish",
  interrupted: "This tidy-up was interrupted"
}

function Stopped({ run, onBack }: { readonly run: Run; readonly onBack: () => void }) {
  const { busy, start } = useStartTidy()
  const status = run.status === "running" || run.status === "succeeded" ? "failed" : run.status
  return (
    <div className="wf-screen">
      <SubHeader title="Tidy up" onBack={onBack} />
      <main className="wf-main">
        <section className="wf-card wf-stopped" aria-labelledby="wf-stopped-title">
          <h2 id="wf-stopped-title" className="wf-stopped-title">{STOPPED_TITLE[status]}</h2>
          <p>{run.error?.message ?? "Nothing was saved or closed."}</p>
          {run.mode === "api" ? null : <p className="wf-sub">To try again, ask {agentName(run.agent)} to tidy up your tabs.</p>}
          <div className="wf-item-actions">
            {run.mode === "api"
              ? (
                <button type="button" className="wf-primary wf-primary-small" onClick={start} disabled={busy}>
                  Start again
                </button>
              )
              : null}
            <button type="button" className="wf-text-button" onClick={onBack}>Back to your list</button>
          </div>
        </section>
      </main>
    </div>
  )
}
