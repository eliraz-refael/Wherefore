/**
 * Due dates on Your list: calendar days in the user's zone, the pill and the words. "Now" is built
 * from local fields, so these hold in any time zone the tests run in.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Due } from "@wherefore/core"
import { daysBetween, dueView, localToday, parseCalendarDate, relativeDays, shortDate } from "../src/ui/dates.ts"

/** Thu 8 Oct 2026, at `hour`:`minute` local time. */
const thu8Oct = (hour = 12, minute = 0) => new Date(2026, 9, 8, hour, minute).getTime()
const due = (date: string, kind: Due["kind"] = "due"): Due => ({ date, kind, source: "" })

describe("calendar days", () => {
  it("reads YYYY-MM-DD as a calendar day, and refuses what isn't a date", () => {
    expect(parseCalendarDate("2026-10-12")).toEqual({ year: 2026, month: 10, day: 12 })
    expect(parseCalendarDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 })
    expect(parseCalendarDate("2026-02-29")).toBeUndefined()
    expect(parseCalendarDate("2026-13-01")).toBeUndefined()
    expect(parseCalendarDate("12 Oct")).toBeUndefined()
  })

  it("today is the local calendar day, from just after midnight to just before the next", () => {
    expect(localToday(new Date(2026, 9, 8, 0, 1).getTime())).toEqual({ year: 2026, month: 10, day: 8 })
    expect(localToday(new Date(2026, 9, 8, 23, 59).getTime())).toEqual({ year: 2026, month: 10, day: 8 })
  })

  it("counts days across month and year ends", () => {
    expect(daysBetween({ year: 2026, month: 10, day: 31 }, { year: 2026, month: 11, day: 1 })).toBe(1)
    expect(daysBetween({ year: 2026, month: 12, day: 31 }, { year: 2027, month: 1, day: 1 })).toBe(1)
    expect(daysBetween({ year: 2027, month: 1, day: 1 }, { year: 2026, month: 12, day: 30 })).toBe(-2)
    expect(daysBetween({ year: 2028, month: 2, day: 28 }, { year: 2028, month: 3, day: 1 })).toBe(2)
    // Across a daylight saving change (late March / October in many zones).
    expect(daysBetween({ year: 2026, month: 3, day: 28 }, { year: 2026, month: 3, day: 30 })).toBe(2)
  })

  it("writes a day short, with the year only when it isn't this year", () => {
    const today = { year: 2026, month: 10, day: 8 }
    expect(shortDate({ year: 2026, month: 10, day: 12 }, today)).toBe("Mon 12 Oct")
    expect(shortDate({ year: 2027, month: 1, day: 3 }, today)).toBe("Sun 3 Jan 2027")
  })

  it("says how far off a day is", () => {
    expect([0, 1, 4, -1, -3].map(relativeDays)).toEqual(["today", "tomorrow", "in 4 days", "yesterday", "3 days ago"])
  })
})

describe("dueView", () => {
  it("today and tomorrow are soon", () => {
    expect(dueView(due("2026-10-08"), thu8Oct())).toEqual({
      short: "Thu 8 Oct",
      long: "Due Thu 8 Oct, today",
      soon: true,
      past: false,
      days: 0
    })
    expect(dueView(due("2026-10-09", "event"), thu8Oct())).toMatchObject({
      short: "Fri 9 Oct",
      long: "Event on Fri 9 Oct, tomorrow",
      soon: true
    })
  })

  it("is soon up to 3 days ahead, then not", () => {
    expect(dueView(due("2026-10-11"), thu8Oct())).toMatchObject({ long: "Due Sun 11 Oct, in 3 days", soon: true })
    expect(dueView(due("2026-10-12", "renews"), thu8Oct())).toMatchObject({
      short: "Mon 12 Oct",
      long: "Renews Mon 12 Oct, in 4 days",
      soon: false
    })
  })

  it("a past deadline is overdue; other past dates are past; both are soon", () => {
    expect(dueView(due("2026-10-05"), thu8Oct())).toMatchObject({
      short: "Overdue · Mon 5 Oct",
      long: "Due Mon 5 Oct, 3 days ago",
      soon: true,
      past: true
    })
    expect(dueView(due("2026-10-07", "expires"), thu8Oct())).toMatchObject({
      short: "Past · Wed 7 Oct",
      long: "Expires Wed 7 Oct, yesterday",
      past: true
    })
  })

  it("uses the local day late at night and just after midnight", () => {
    // 23:59 on the 8th: the 9th is still tomorrow, wherever the user is.
    expect(dueView(due("2026-10-09"), thu8Oct(23, 59))?.days).toBe(1)
    // 00:01 on the 8th: the 8th is today, not yesterday.
    expect(dueView(due("2026-10-08"), thu8Oct(0, 1))?.days).toBe(0)
  })

  it("crosses month and year ends", () => {
    const dec30 = new Date(2026, 11, 30, 9).getTime()
    expect(dueView(due("2027-01-02", "starts"), dec30)).toMatchObject({
      short: "Sat 2 Jan 2027",
      long: "Starts Sat 2 Jan 2027, in 3 days",
      soon: true
    })
    const nov1 = new Date(2026, 10, 1, 9).getTime()
    expect(dueView(due("2026-10-31"), nov1)).toMatchObject({ short: "Overdue · Sat 31 Oct", long: "Due Sat 31 Oct, yesterday" })
  })

  it("shows nothing for a date it can't read", () => {
    expect(dueView(due("2026-02-30"), thu8Oct())).toBeUndefined()
  })
})
