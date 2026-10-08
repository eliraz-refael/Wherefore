/**
 * The dates on Your list: an item's `due` (a calendar date, `YYYY-MM-DD`, from the pages) as a pill
 * ("Sun 12 Oct") and in words ("Due Sun 12 Oct, in 4 days").
 *
 * A due date is a day on the calendar, not an instant. "Today" is the user's local calendar day,
 * read from local date fields; a `YYYY-MM-DD` string is never parsed as a time (that would be UTC
 * midnight, the day before in the Americas). Days between two dates are counted on the calendar,
 * so daylight saving changes don't shift them. Pure, so it is easy to test.
 */
import type { Due, DueKind } from "@wherefore/core"

/** A day on the calendar. `month` is 1–12. */
export interface CalendarDay {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Within this many days (or overdue), a date is shown as soon. */
export const SOON_DAYS = 3

const DAY_MS = 86_400_000
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** `YYYY-MM-DD` as a calendar day; `undefined` when it isn't a real date. */
export const parseCalendarDate = (text: string): CalendarDay | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return undefined
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  // The clock rolls 31 Feb over to March: a real date comes back unchanged.
  const back = utcMidnight(day)
  return back.getUTCFullYear() === day.year && back.getUTCMonth() + 1 === day.month && back.getUTCDate() === day.day
    ? day
    : undefined
}

/** The user's calendar day at `nowMs`, in their time zone. */
export const localToday = (nowMs: number): CalendarDay => {
  const now = new Date(nowMs)
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
}

/**
 * The day's midnight on the UTC clock, which is only used to count, never for a zone.
 * setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999 (as core's CalendarDate).
 */
const utcMidnight = (day: CalendarDay): Date => {
  const date = new Date(0)
  date.setUTCFullYear(day.year, day.month - 1, day.day)
  return date
}

/** Days since 1970-01-01 on the calendar. */
const dayNumber = (day: CalendarDay): number => utcMidnight(day).getTime() / DAY_MS

/** Calendar days from `from` to `to`: 1 when `to` is the day after, negative when it is before. */
export const daysBetween = (from: CalendarDay, to: CalendarDay): number => dayNumber(to) - dayNumber(from)

const weekday = (day: CalendarDay): string => WEEKDAYS[utcMidnight(day).getUTCDay()] ?? ""

/** "Sun 12 Oct"; with the year when it isn't this year: "Sun 3 Jan 2027". */
export const shortDate = (day: CalendarDay, today: CalendarDay): string =>
  `${weekday(day)} ${day.day} ${MONTHS[day.month - 1]}${day.year === today.year ? "" : ` ${day.year}`}`

/** "today", "tomorrow", "in 4 days", "yesterday", "3 days ago". */
export const relativeDays = (days: number): string => {
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  if (days === -1) return "yesterday"
  return days > 0 ? `in ${days} days` : `${-days} days ago`
}

const kindLead: { readonly [K in DueKind]: string } = {
  due: "Due",
  event: "Event on",
  renews: "Renews",
  expires: "Expires",
  starts: "Starts"
}

/** An item's date, ready to show. */
export interface DueView {
  /** The pill on the row: "Sun 12 Oct", "Overdue · Sun 12 Oct" (a deadline), "Past · Sun 12 Oct". */
  readonly short: string
  /** In the expanded item: "Due Sun 12 Oct, in 4 days". */
  readonly long: string
  /** Within `SOON_DAYS`, or past: shown warm. */
  readonly soon: boolean
  readonly past: boolean
  readonly days: number
}

/** How to show `due` on `nowMs`'s day; `undefined` when its date can't be read. */
export const dueView = (due: Due, nowMs: number): DueView | undefined => {
  const day = parseCalendarDate(due.date)
  if (day === undefined) return undefined
  const today = localToday(nowMs)
  const days = daysBetween(today, day)
  const date = shortDate(day, today)
  const past = days < 0
  return {
    short: past ? `${due.kind === "due" ? "Overdue" : "Past"} · ${date}` : date,
    long: `${kindLead[due.kind]} ${date}, ${relativeDays(days)}`,
    soon: days <= SOON_DAYS,
    past,
    days
  }
}
