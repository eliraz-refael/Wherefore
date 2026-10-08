import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import {
  Answer,
  checkCoverage,
  CoverageError,
  Intention,
  Question,
  SubmittedIntention,
  TabId,
  WindowId
} from "../src/index.ts"
import { decodeOk, encodeOk, rejects } from "./helpers.ts"

const wireIntention = {
  title: "Finish reviewing the auth PR",
  why: "Review requested yesterday",
  next_step: "Approve or request changes on #412",
  kind: "work",
  tab_ids: [11, 12],
  confidence: "high",
  evidence: "PR open, review requested"
}

describe("branded ids", () => {
  it("accept non-negative integers and reject the rest", () => {
    expect(decodeOk(TabId, 0)).toBe(0)
    expect(decodeOk(WindowId, 1580)).toBe(1580)
    expect(rejects(TabId, -1)).toBe(true) // chrome.tabs.TAB_ID_NONE
    expect(rejects(TabId, 1.5)).toBe(true)
    expect(rejects(TabId, "12")).toBe(true)
    expect(rejects(WindowId, Number.NaN)).toBe(true)
  })
})

describe("SubmittedIntention", () => {
  it("decodes the model's snake_case wire form into camelCase", () => {
    const intention = decodeOk(SubmittedIntention, wireIntention)
    expect(intention.nextStep).toBe("Approve or request changes on #412")
    expect(intention.tabIds).toEqual([11, 12])
    expect(intention).not.toHaveProperty("tab_ids")
  })

  it("encodes back to the wire form", () => {
    const intention = decodeOk(SubmittedIntention, wireIntention)
    expect(encodeOk(SubmittedIntention, intention)).toEqual(wireIntention)
  })

  it("treats next_step as optional", () => {
    const { next_step: _, ...withoutNextStep } = wireIntention
    const intention = decodeOk(SubmittedIntention, { ...withoutNextStep, kind: "dead" })
    expect(intention.nextStep).toBeUndefined()
    expect(encodeOk(SubmittedIntention, intention)).not.toHaveProperty("next_step")
  })

  it("carries an optional short_title and a due date the pages gave", () => {
    const wire = {
      ...wireIntention,
      short_title: "School registration + bills",
      due: { date: "2026-10-12", kind: "due", source: "Registration closes 12 October" }
    }
    const intention = decodeOk(SubmittedIntention, wire)
    expect(intention.shortTitle).toBe("School registration + bills")
    expect(intention.due).toEqual({ date: "2026-10-12", kind: "due", source: "Registration closes 12 October" })
    expect(encodeOk(SubmittedIntention, intention)).toEqual(wire)
    expect(decodeOk(SubmittedIntention, wireIntention)).not.toHaveProperty("due")
  })

  it("accepts only real calendar dates, past ones too", () => {
    const due = (date: string, kind = "event") => ({ ...wireIntention, due: { date, kind, source: "x" } })
    for (const date of ["2026-10-16", "2024-02-29", "2020-01-01"]) {
      expect(rejects(SubmittedIntention, due(date))).toBe(false)
    }
    for (const date of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-10-1", "12/10/2026", "2026-10-12T10:00", ""]) {
      expect(rejects(SubmittedIntention, due(date))).toBe(true)
    }
    expect(rejects(SubmittedIntention, due("2026-10-12", "deadline"))).toBe(true)
    expect(rejects(SubmittedIntention, { ...wireIntention, due: { date: "2026-10-12", kind: "due" } })).toBe(true)
  })

  it("rejects bad input", () => {
    expect(rejects(SubmittedIntention, { ...wireIntention, tab_ids: [] })).toBe(true)
    expect(rejects(SubmittedIntention, { ...wireIntention, tab_ids: [-3] })).toBe(true)
    expect(rejects(SubmittedIntention, { ...wireIntention, kind: "shopping" })).toBe(true)
    expect(rejects(SubmittedIntention, { ...wireIntention, confidence: "certain" })).toBe(true)
    expect(rejects(SubmittedIntention, { ...wireIntention, title: "" })).toBe(true)
    expect(rejects(SubmittedIntention, { ...wireIntention, next_step: 3 })).toBe(true)
    const { why: _, ...withoutWhy } = wireIntention
    expect(rejects(SubmittedIntention, withoutWhy)).toBe(true)
    // camelCase is the domain form, not the wire form
    const { tab_ids: __, ...withoutTabIds } = wireIntention
    expect(rejects(SubmittedIntention, { ...withoutTabIds, tabIds: [11] })).toBe(true)
    expect(decodeOk(SubmittedIntention, { ...wireIntention, shortTitle: "x" })).not.toHaveProperty("shortTitle")
  })
})

describe("Intention", () => {
  it("carries an id and round-trips", () => {
    const stored = {
      id: "int-1",
      title: "Follow the Vite 8 release",
      why: "Waiting for the release",
      kind: "track",
      tabIds: [3],
      confidence: "medium",
      evidence: "release tracking issue"
    }
    const intention = decodeOk(Intention, stored)
    expect(intention.id).toBe("int-1")
    expect(encodeOk(Intention, intention)).toEqual(stored)
    expect(rejects(Intention, { ...stored, id: "" })).toBe(true)
  })
})

describe("Question and Answer", () => {
  const wireQuestion = {
    id: "q1",
    tab_ids: [7, 8],
    question: "Are you still comparing these standing desks?",
    options: ["Yes, still deciding", "Bought one already", "Not interested any more"]
  }

  it("names the tabs it is about", () => {
    const question = decodeOk(Question, wireQuestion)
    expect(question.tabIds).toEqual([7, 8])
    expect(encodeOk(Question, question)).toEqual(wireQuestion)
  })

  it("rejects bad input", () => {
    expect(rejects(Question, { ...wireQuestion, tab_ids: [] })).toBe(true)
    const { tab_ids: _, ...withoutTabs } = wireQuestion
    expect(rejects(Question, withoutTabs)).toBe(true)
    expect(rejects(Question, { ...wireQuestion, options: ["a", "b", "c", "d", "e"] })).toBe(true)
    expect(rejects(Question, { ...wireQuestion, options: [""] })).toBe(true)
    expect(rejects(Question, { ...wireQuestion, question: "" })).toBe(true)
    expect(rejects(Question, { ...wireQuestion, id: "" })).toBe(true)
  })

  it("answers echo the question id", () => {
    expect(decodeOk(Answer, { id: "q1", answer: "Bought one already" })).toEqual({
      id: "q1",
      answer: "Bought one already"
    })
    expect(rejects(Answer, { id: "q1" })).toBe(true)
  })
})

describe("checkCoverage", () => {
  const ids = (...values: Array<number>) => values.map((value) => decodeOk(TabId, value))
  const intention = (...tabIds: Array<number>) => ({ tabIds: ids(...tabIds) })

  it("accepts intentions that cover every known tab exactly once", () => {
    const intentions = [intention(1, 2), intention(3)]
    const result = checkCoverage(ids(1, 2, 3), intentions)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(result.success).toBe(intentions)
  })

  it("reports missing, repeated and unknown tabs together", () => {
    const result = checkCoverage(ids(1, 2, 3, 4), [intention(1, 2), intention(2, 9)])
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      const error = result.failure
      expect(error).toBeInstanceOf(CoverageError)
      expect(error.missing).toEqual([3, 4])
      expect(error.repeated).toEqual([2])
      expect(error.unknown).toEqual([9])
      expect(error.message).toBe(
        "Fix and resubmit all intentions. Missing tab ids: [3, 4]. In more than one intention: [2]. Unknown tab ids: [9]."
      )
    }
  })

  it("counts a tab repeated within one intention", () => {
    const result = checkCoverage(ids(1), [intention(1, 1)])
    expect(Result.isFailure(result) && result.failure.repeated).toEqual([1])
  })

  it("only mentions the problems there are", () => {
    const result = checkCoverage(ids(1, 2), [intention(1)])
    expect(Result.isFailure(result) && result.failure.message).toBe(
      "Fix and resubmit all intentions. Missing tab ids: [2]."
    )
  })
})
