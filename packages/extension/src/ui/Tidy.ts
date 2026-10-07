/**
 * Tidy up, for a view: starts API-mode runs in this page (`TriageAgent`), and answers or stops a
 * run wherever it lives.
 *
 * A run lives in the page that started it (architecture A4), but every open view shows it (from the
 * Store). So a side panel in another window can show a run's question, or its Stop button, while
 * the run's `QuestionsInbox` and handle are in the first panel. Views pass those two requests
 * between them over a same-origin `BroadcastChannel` (`RelayChannel`): the page that owns the run
 * answers or cancels it, and the first answer still wins (`QuestionsInbox.answer`).
 *
 * A run the companion drives (MCP, ACP) has no owning page: its questions wait in the worker, so
 * answers and Stop go to the worker (`answer_ask`, `stop_run`), and the first answer wins there.
 */
import { Answer, type QuestionStep, type Run, RunId } from "@wherefore/core"
import { Context, Deferred, Duration, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { QuestionsInbox } from "../agent/Questions.ts"
import { type RunHandle, type StartError, TriageAgent } from "../agent/TriageAgent.ts"
import { WorkerClient } from "../messaging/WorkerClient.ts"
import { RunLocks } from "../runs/RunLocks.ts"

/** How long a view waits for the page that owns a run to confirm an answer. */
export const RELAY_TIMEOUT = Duration.seconds(3)
export const RELAY_CHANNEL = "wherefore/runs"

const RelayMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("answer"),
    requestId: Schema.String,
    runId: RunId,
    askId: Schema.String,
    answers: Schema.Array(Answer)
  }),
  Schema.Struct({ type: Schema.Literal("answered"), requestId: Schema.String, accepted: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("cancel"), runId: RunId })
])
type RelayMessage = typeof RelayMessage.Type

const decodeMessage = Schema.decodeUnknownOption(RelayMessage)
const encodeMessage = Schema.encodeSync(RelayMessage)

/** Messages between the extension's pages. Only this extension's own pages share the channel. */
export class RelayChannel extends Context.Service<RelayChannel, {
  readonly post: (message: unknown) => Effect.Effect<void>
  /** Messages from other pages (never this page's own), as received: decode before use. */
  readonly messages: Stream.Stream<unknown>
}>()("@wherefore/extension/RelayChannel") {
  /** A `BroadcastChannel`, closed with the layer. */
  static readonly layer: Layer.Layer<RelayChannel> = Layer.effect(RelayChannel)(
    Effect.map(
      Effect.acquireRelease(Effect.sync(() => new BroadcastChannel(RELAY_CHANNEL)), (channel) => Effect.sync(() => channel.close())),
      (channel) =>
        RelayChannel.of({
          post: (message) => Effect.sync(() => channel.postMessage(message)),
          messages: Stream.callback<unknown>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const listener = (event: MessageEvent) => void Queue.offerUnsafe(queue, event.data)
                channel.addEventListener("message", listener)
                return listener
              }),
              (listener) => Effect.sync(() => channel.removeEventListener("message", listener))
            )
          )
        })
    )
  )
}

export class Tidy extends Context.Service<Tidy, {
  /** Starts a run in this page. */
  readonly start: Effect.Effect<RunId, StartError>
  /**
   * Answers an ask, in this page, the page that owns it, or the worker (companion runs). False when
   * it was already answered (or withdrawn), or nobody owns it any more.
   */
  readonly answer: (run: Pick<Run, "id" | "mode">, askId: string, answers: ReadonlyArray<Answer>) => Effect.Effect<boolean>
  /** Stops a running run, in this page, the page that owns it, or the worker (companion runs). */
  readonly cancel: (run: Pick<Run, "id" | "mode">) => Effect.Effect<void>
  /** True when the run was started by this page. */
  readonly isLocal: (id: RunId) => boolean
  /**
   * Completes once the page running `run` is gone (its Web Lock is free), after the worker has
   * marked the stored run interrupted if it didn't finish.
   */
  readonly whenGone: (id: RunId) => Effect.Effect<void>
}>()("@wherefore/extension/Tidy") {
  static readonly layer: Layer.Layer<Tidy, never, TriageAgent | QuestionsInbox | RunLocks | RelayChannel | WorkerClient> =
    Layer.effect(Tidy)(Effect.suspend(() => make))
}

const make = Effect.gen(function*() {
  const agent = yield* TriageAgent
  const inbox = yield* QuestionsInbox
  const locks = yield* RunLocks
  const channel = yield* RelayChannel
  const worker = yield* WorkerClient
  const runs = new Map<RunId, RunHandle>()
  const waiting = new Map<string, Deferred.Deferred<boolean>>()

  const post = (message: RelayMessage) => channel.post(encodeMessage(message))

  const onMessage = (message: RelayMessage): Effect.Effect<void> => {
    switch (message.type) {
      case "answer":
        return Effect.gen(function*() {
          // Only the page running the run replies; other views stay quiet.
          if (!runs.has(message.runId)) return
          const accepted = yield* inbox.answer(message.askId, message.answers)
          yield* post({ type: "answered", requestId: message.requestId, accepted })
        })
      case "answered":
        return Effect.suspend(() => {
          const deferred = waiting.get(message.requestId)
          return deferred === undefined ? Effect.void : Deferred.succeed(deferred, message.accepted)
        })
      case "cancel":
        return Effect.suspend(() => {
          const handle = runs.get(message.runId)
          return handle === undefined ? Effect.void : handle.cancel
        })
    }
  }

  yield* channel.messages.pipe(
    Stream.runForEach((raw) =>
      Option.match(decodeMessage(raw), {
        onNone: () => Effect.logWarning("Tidy: dropped a malformed message from another page"),
        onSome: (message) => Effect.forkDetach(onMessage(message))
      })
    ),
    Effect.forkScoped
  )

  const start = Effect.map(agent.start(), (handle) => {
    runs.set(handle.id, handle)
    return handle.id
  })

  const answerElsewhere = (runId: RunId, askId: string, answers: ReadonlyArray<Answer>) =>
    Effect.suspend(() => {
      const requestId = crypto.randomUUID()
      const deferred = Deferred.makeUnsafe<boolean>()
      waiting.set(requestId, deferred)
      return Effect.andThen(post({ type: "answer", requestId, runId, askId, answers }), Deferred.await(deferred)).pipe(
        Effect.timeoutOption(RELAY_TIMEOUT),
        Effect.map((accepted) => Option.getOrElse(accepted, () => false)),
        Effect.ensuring(Effect.sync(() => waiting.delete(requestId)))
      )
    })

  // The first answer wins (`QuestionsInbox.answer`, or the worker's inbox), wherever it comes from.
  const answer = (run: Pick<Run, "id" | "mode">, askId: string, answers: ReadonlyArray<Answer>) =>
    run.mode !== "api"
      ? worker.call("answer_ask", { runId: run.id, askId, answers }).pipe(Effect.orElseSucceed(() => false))
      : runs.has(run.id)
      ? inbox.answer(askId, answers)
      : answerElsewhere(run.id, askId, answers)

  const cancel = (run: Pick<Run, "id" | "mode">) =>
    Effect.suspend(() => {
      if (run.mode !== "api") {
        return worker.call("stop_run", { id: run.id }).pipe(
          Effect.catch((error) => Effect.logWarning(`Tidy: couldn't stop run ${run.id}: ${error.message}`))
        )
      }
      const handle = runs.get(run.id)
      return handle === undefined ? post({ type: "cancel", runId: run.id }) : handle.cancel
    })

  const whenGone = (id: RunId) =>
    Effect.andThen(
      locks.whenReleased(id),
      worker.call("check_runs", undefined).pipe(Effect.catch(() => Effect.void))
    )

  return Tidy.of({ start, answer, cancel, isLocal: (id) => runs.has(id), whenGone })
})

/**
 * The questions a running run is waiting on: its newest question step, while it has no answers.
 * The step's `callId` is the ask's id (`Tidy.answer`).
 */
export const pendingAsk = (run: Run): Option.Option<QuestionStep> => {
  if (run.status !== "running") return Option.none()
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i]
    if (step?.kind === "question") return step.answers === undefined ? Option.some(step) : Option.none()
  }
  return Option.none()
}
