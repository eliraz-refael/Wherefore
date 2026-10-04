/**
 * Intentions: why a group of tabs is open. The model submits them; the user reviews them.
 *
 * Wire shapes (what the model writes) use snake_case keys, as the tool schemas show the
 * model; the decoded domain values use camelCase (`Schema.encodeKeys`).
 */
import { Result, Schema } from "effect"
import { IntentionId, QuestionId, TabId } from "./ids.ts"

export const IntentionKind = Schema.Literals([
  "work", // an active task to continue
  "track", // waiting on something external to change
  "decide", // comparing options, considering a purchase or a tool
  "read", // something to read, watch or learn
  "reference", // keep for lookup, no action implied
  "app", // an everyday tool or inbox: keep open, not an intention
  "done", // the underlying thing is finished: safe to close
  "dead" // duplicate, expired login, error or callback page: safe to close
])
export type IntentionKind = typeof IntentionKind.Type

export const Confidence = Schema.Literals(["high", "medium", "low"])
export type Confidence = typeof Confidence.Type

const TabIds = Schema.Array(TabId).check(Schema.isMinLength(1))

const intentionFields = {
  title: Schema.NonEmptyString.annotate({
    description: "Action-oriented, specific. \"Decide which cat litter to buy\", not \"Shopping\"."
  }),
  why: Schema.String.annotate({
    description: "The user's reason for keeping these tabs open, in one sentence."
  }),
  nextStep: Schema.optionalKey(Schema.String.annotate({
    description:
      "The one-line task the person would write on their own to-do list, e.g. \"Reply to Dana about the API limits\". Give one for work, track, decide and read; omit it otherwise."
  })),
  kind: IntentionKind,
  tabIds: TabIds,
  confidence: Confidence,
  evidence: Schema.String.annotate({
    description: "Short: which signals led to this (titles, page content, PR state, user answer)."
  })
}

/** An intention as the model submits it through `submit_intentions`. */
export const SubmittedIntention = Schema.Struct(intentionFields).pipe(
  Schema.encodeKeys({ nextStep: "next_step", tabIds: "tab_ids" })
)
export type SubmittedIntention = typeof SubmittedIntention.Type

/** An intention within a run, with the id the UI and storage refer to it by. */
export const Intention = Schema.Struct({ id: IntentionId, ...intentionFields })
export type Intention = typeof Intention.Type

/** A question to the user about specific tabs, so the UI can show which tabs it means. */
export const Question = Schema.Struct({
  id: QuestionId,
  tabIds: TabIds.annotate({ description: "The tabs this question is about." }),
  question: Schema.NonEmptyString,
  options: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(4)).annotate({
    description: "2-4 likely answers the user can click."
  })
}).pipe(Schema.encodeKeys({ tabIds: "tab_ids" }))
export type Question = typeof Question.Type

export const Answer = Schema.Struct({
  id: QuestionId,
  answer: Schema.String
})
export type Answer = typeof Answer.Type

/**
 * `submit_intentions` was rejected because the intentions don't cover every known tab
 * exactly once. Returned to the model, which fixes and resubmits.
 */
export class CoverageError extends Schema.TaggedError<CoverageError>()("CoverageError", {
  message: Schema.String,
  missing: Schema.Array(TabId),
  repeated: Schema.Array(TabId),
  unknown: Schema.Array(TabId)
}) {}

/** Every known tab must be in exactly one intention, and no intention may name an unknown tab. */
export const checkCoverage = <I extends { readonly tabIds: ReadonlyArray<TabId> }>(
  known: Iterable<TabId>,
  intentions: ReadonlyArray<I>
): Result.Result<ReadonlyArray<I>, CoverageError> => {
  const knownSet = new Set(known)
  const seen = new Map<TabId, number>()
  for (const intention of intentions) {
    for (const id of intention.tabIds) seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  const missing = [...knownSet].filter((id) => !seen.has(id))
  const repeated = [...seen].filter(([, count]) => count > 1).map(([id]) => id)
  const unknown = [...seen.keys()].filter((id) => !knownSet.has(id))
  if (missing.length === 0 && repeated.length === 0 && unknown.length === 0) return Result.succeed(intentions)

  const problems = [
    missing.length > 0 ? `Missing tab ids: [${missing.join(", ")}].` : "",
    repeated.length > 0 ? `In more than one intention: [${repeated.join(", ")}].` : "",
    unknown.length > 0 ? `Unknown tab ids: [${unknown.join(", ")}].` : ""
  ].filter((part) => part !== "")
  return Result.fail(
    new CoverageError({
      message: `Fix and resubmit all intentions. ${problems.join(" ")}`,
      missing,
      repeated,
      unknown
    })
  )
}
