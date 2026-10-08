/**
 * Small display helpers for the side panel (and, from M3, the full page). Pure: no React, no Effect
 * services, so they are easy to test.
 */
import { domainOf, type ItemTag } from "@wherefore/core"
import { DateTime } from "effect"

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export const tabCount = (n: number): string => plural(n, "tab")

/**
 * The sections the list (and the Tidy up results) group items into, in order. Until the list
 * shows each item's tag, do and decide share "To do".
 */
export type ListSection = "todo" | "follow_up" | "read" | "keep"

export const SECTION_ORDER: ReadonlyArray<ListSection> = ["todo", "follow_up", "read", "keep"]

export const sectionLabel: { readonly [S in ListSection]: string } = {
  todo: "To do",
  follow_up: "Follow up",
  read: "Read",
  keep: "Keep"
}

const sectionOfTag: { readonly [T in ItemTag]: ListSection } = {
  do: "todo",
  decide: "todo",
  track: "follow_up",
  read: "read",
  keep: "keep"
}

/** Each section's own tag, for an item moved there. */
const sectionTag: { readonly [S in ListSection]: ItemTag } = { todo: "do", follow_up: "track", read: "read", keep: "keep" }

export const sectionOf = (tag: ItemTag): ListSection => sectionOfTag[tag]

/** The tag for an item moved to `section`: `tag` when it is in that section already. */
export const tagIn = (section: ListSection, tag: ItemTag): ItemTag => sectionOf(tag) === section ? tag : sectionTag[section]

const KNOWN_AGENTS: Readonly<Record<string, string>> = { "claude-code": "Claude Code", "claude-ai": "Claude" }

/**
 * Who runs a companion run, for display: a known agent's name, the name the agent gave (an MCP
 * client's `clientInfo`, at most 40 characters), or "An agent".
 */
export const agentName = (agent: string | undefined): string => {
  const name = agent?.trim() ?? ""
  if (name === "") return "An agent"
  return KNOWN_AGENTS[name.toLowerCase()] ?? (name.length > 40 ? `${name.slice(0, 39)}…` : name)
}

const DAY_MS = 86_400_000

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** Local midnight of the day `ms` falls on. */
const startOfDay = (ms: number): number => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * When something happened, the way a person says it: "today", "yesterday", "Monday" (within the
 * last week), "last week", else "on 5 Sep" (with the year when it isn't this year).
 */
export const whenLabel = (at: DateTime.Utc, nowMs: number): string => {
  const ms = DateTime.toEpochMillis(at)
  const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / DAY_MS)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  const date = new Date(ms)
  if (days < 7) return WEEKDAYS[date.getDay()] ?? "this week"
  if (days < 14) return "last week"
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear()
  return `on ${date.getDate()} ${MONTHS[date.getMonth()]}${sameYear ? "" : ` ${date.getFullYear()}`}`
}

/** Monday 00:00 (local time) of the week `ms` falls in. */
export const startOfWeek = (ms: number): number => {
  const day = new Date(startOfDay(ms))
  const sinceMonday = (day.getDay() + 6) % 7
  day.setDate(day.getDate() - sinceMonday)
  return day.getTime()
}

/** "This week", "Last week" or "Earlier", by calendar week (weeks start on Monday). */
export const weekBucket = (at: DateTime.Utc, nowMs: number): "This week" | "Last week" | "Earlier" => {
  const ms = DateTime.toEpochMillis(at)
  const thisWeek = startOfWeek(nowMs)
  if (ms >= thisWeek) return "This week"
  if (ms >= thisWeek - 7 * DAY_MS) return "Last week"
  return "Earlier"
}

/**
 * The only form of a saved API key the UI shows: its last four characters. Short keys show
 * nothing of themselves.
 */
export const maskKey = (key: string): string => (key.length >= 12 ? `•••• ${key.slice(-4)}` : "••••")

/** The domain to show next to a tab title; the raw text when it isn't a URL. */
export const displayDomain = (url: string): string => {
  const domain = domainOf(url)
  return domain === "" ? url : domain
}

/** Only http(s) pages can be opened from a plain link. */
export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url)

/** "$0.42", "<$0.01". */
export const formatUsd = (usd: number): string => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`)

/**
 * A stand-in for a site's icon: the domain's first letter on a colour picked from the domain, so
 * no favicon is fetched from the site (no network request leaves the panel).
 */
export const siteBadge = (domain: string): { readonly letter: string; readonly hue: number } => {
  const name = domain.replace(/^[a-z]+:\/\//i, "")
  const letter = (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase()
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return { letter, hue: hash % 360 }
}
