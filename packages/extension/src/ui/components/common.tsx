/**
 * Pieces every screen uses: icons, the screen header, a tab row (title + domain, never a bare
 * icon), and the notice for data that can't be read.
 *
 * Everything that came from the web (titles, URLs, page-derived text) is rendered as React text,
 * never as HTML.
 */
import { type ItemTag, tagLabel } from "@wherefore/core"
import type { ReactNode } from "react"
import { siteBadge } from "../format.ts"

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round"
} as const

export const LogoIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} strokeWidth="1.8" className="wf-logo" aria-hidden="true">
    <rect x="3" y="7" width="14" height="13" rx="3" />
    <path d="M7 4h11a3 3 0 0 1 3 3v9" />
    <path d="m7.5 13.5 2.5 2.5 4.5-5" />
  </svg>
)

export const GearIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)

export const BackIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth="1.8" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
)

export const CheckIcon = ({ size = 14 }: { readonly size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth="2.4" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const ChevronIcon = ({ open }: { readonly open: boolean }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    {...stroke}
    strokeWidth="2"
    aria-hidden="true"
    className={open ? "wf-chevron wf-chevron-open" : "wf-chevron"}
  >
    <path d="m9 6 6 6-6 6" />
  </svg>
)

export const CalendarIcon = ({ size = 16 }: { readonly size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth="2.2" aria-hidden="true" className="wf-calendar">
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M16 3v4M8 3v4M3 10h18" />
  </svg>
)

export const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth="2" aria-hidden="true" className="wf-search-icon">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
)

/** What kind of thing an item is ("Do", "Track", …): a tinted chip, the same width for every tag. */
export const TagChip = ({ tag, id }: { readonly tag: ItemTag; readonly id?: string }) => (
  <span id={id} className={`wf-tag wf-tag-${tag}`}>{tagLabel[tag]}</span>
)

/** A screen's title. Focused when the screen opens, so keyboard and screen reader users land on it. */
export const ScreenTitle = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <h1 className={className ?? "wf-screen-title"} tabIndex={-1} data-screen-heading="">
    {children}
  </h1>
)

export const BackButton = ({ onBack }: { readonly onBack: () => void }) => (
  <button type="button" className="wf-icon-button" aria-label="Back to your list" onClick={onBack}>
    <BackIcon />
  </button>
)

/** The header of a screen below home: back, title, and an optional action. */
export const SubHeader = (
  { title, onBack, action }: { readonly title: string; readonly onBack: () => void; readonly action?: ReactNode }
) => (
  <header className="wf-header">
    <BackButton onBack={onBack} />
    <ScreenTitle className="wf-header-title">{title}</ScreenTitle>
    {action}
  </header>
)

export const SiteBadge = ({ domain }: { readonly domain: string }) => {
  const { letter, hue } = siteBadge(domain)
  return (
    <span className="wf-badge" aria-hidden="true" style={{ background: `hsl(${hue} 45% 38%)` }}>
      {letter}
    </span>
  )
}

/** A tab's title and domain. */
export const TabText = ({ title, domain }: { readonly title: string; readonly domain: string }) => (
  <span className="wf-tab-text">
    <span className="wf-tab-title">{title === "" ? domain : title}</span>
    <span className="wf-tab-domain">{domain}</span>
  </span>
)

/** Shown instead of a screen when its data can't be read, with the way out. */
export const StoreProblem = (
  { what, onReset, busy }: { readonly what: string; readonly onReset: () => void; readonly busy: boolean }
) => (
  <section className="wf-card wf-problem" aria-labelledby="wf-problem-title">
    <h2 id="wf-problem-title" className="wf-problem-title">{what} couldn't be read</h2>
    <p>
      It may have been saved by a newer version of Wherefore, or damaged. Nothing has been deleted: a copy is kept
      in the extension's storage.
    </p>
    <button type="button" className="wf-button" onClick={onReset} disabled={busy}>
      Start fresh (keeps the copy)
    </button>
  </section>
)
