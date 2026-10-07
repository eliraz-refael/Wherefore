/**
 * How the agent asks the user (`ask_user`). The UI implements it (M1 PR 4); the agent only waits
 * for answers, and interrupting the wait (the run was cancelled) must take the questions down.
 *
 * `makeInbox` is a ready implementation for a page: it publishes the pending questions and takes
 * the first answer to each ask, from wherever it comes. A second answer finds the ask closed and
 * is ignored, so several views can offer the same questions ("the first panel to answer wins").
 * The worker keeps one too, for the questions of runs the companion drives (`CompanionRuns`).
 */
import { type Answer, type Question, QuestionsUnavailable, type RunId } from "@wherefore/core"
import { Context, Deferred, Effect, Layer, SubscriptionRef } from "effect"

/** Nobody can answer right now. The model is told and goes on with its best guess. */
export { QuestionsUnavailable }

export interface Ask {
  /** Unique per `ask_user` call (its tool call id). */
  readonly id: string
  readonly runId: RunId
  readonly questions: ReadonlyArray<Question>
}

export class Questions extends Context.Service<Questions, {
  /**
   * Shows the questions and waits for the answers. Answers may come back for some questions only;
   * the agent fills in the rest. Interrupting it must withdraw the questions.
   */
  readonly ask: (ask: Ask) => Effect.Effect<ReadonlyArray<Answer>, QuestionsUnavailable>
}>()("@wherefore/extension/Questions") {}

export interface Inbox {
  readonly questions: Questions["Service"]
  /** The asks waiting for an answer, oldest first; changes as asks open and close. */
  readonly pending: SubscriptionRef.SubscriptionRef<ReadonlyArray<Ask>>
  /** Answers an ask. False when it is no longer open (already answered, or withdrawn). */
  readonly answer: (askId: string, answers: ReadonlyArray<Answer>) => Effect.Effect<boolean>
}

/** An in-page `Questions`: pending asks as state, first answer wins. */
export const makeInbox: Effect.Effect<Inbox> = Effect.gen(function*() {
  const pending = yield* SubscriptionRef.make<ReadonlyArray<Ask>>([])
  const open = new Map<string, Deferred.Deferred<ReadonlyArray<Answer>>>()
  const close = (id: string) =>
    Effect.andThen(
      Effect.sync(() => open.delete(id)),
      SubscriptionRef.update(pending, (asks) => asks.filter((ask) => ask.id !== id))
    )
  const questions: Questions["Service"] = {
    ask: (ask) =>
      Effect.acquireUseRelease(
        Effect.gen(function*() {
          const answered = yield* Deferred.make<ReadonlyArray<Answer>>()
          open.set(ask.id, answered)
          yield* SubscriptionRef.update(pending, (asks) => [...asks, ask])
          return answered
        }),
        (answered) => Deferred.await(answered),
        () => close(ask.id)
      )
  }
  const answer = (askId: string, answers: ReadonlyArray<Answer>) =>
    Effect.suspend(() => {
      const answered = open.get(askId)
      return answered === undefined ? Effect.succeed(false) : Deferred.succeed(answered, answers)
    })
  return { questions, pending, answer }
})

/** `Questions` backed by a fresh inbox, plus the inbox itself for the UI. */
export class QuestionsInbox extends Context.Service<QuestionsInbox, Inbox>()("@wherefore/extension/QuestionsInbox") {
  static readonly layer: Layer.Layer<QuestionsInbox | Questions> = Layer.effectContext(
    Effect.map(makeInbox, (inbox) => Context.make(QuestionsInbox, inbox).pipe(Context.add(Questions, inbox.questions)))
  )
}
