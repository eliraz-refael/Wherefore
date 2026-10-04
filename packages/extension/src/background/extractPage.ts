/**
 * What a page read injects into a tab (`chrome.scripting.executeScript`, isolated world).
 *
 * `extractPage` is serialized and run inside the page, so it must be self-contained: no imports,
 * no closures over module scope. Text comes from `textContent` of text nodes only (never
 * `innerText`, which forces layout, and never HTML), skipping script, style, noscript and
 * template contents. Everything it returns is untrusted page content: the worker decodes it with
 * `RawPage` and clamps it before the model sees it.
 */
import { Schema } from "effect"

export function extractPage(maxChars: number) {
  const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim()
  const SKIP = "script, style, noscript, template"
  const textOf = (root: Node, limit: number): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    })
    const parts: Array<string> = []
    let length = 0
    while (length < limit * 2 && walker.nextNode()) {
      const value = walker.currentNode.nodeValue
      if (value !== null && value.trim() !== "") {
        parts.push(value)
        length += value.length
      }
    }
    return clean(parts.join(" ")).slice(0, limit)
  }
  const meta = (selector: string): string => document.querySelector<HTMLMetaElement>(selector)?.content ?? ""
  const root = document.querySelector("main, [role=main], article") ?? document.body
  const scrollable = document.documentElement.scrollHeight - window.innerHeight
  const video = document.querySelector("video")
  return {
    title: document.title,
    url: location.href,
    headings: Array.from(document.querySelectorAll("h1, h2"), (heading) => clean(heading.textContent))
      .filter((heading) => heading !== "")
      .slice(0, 8),
    description: meta("meta[name=description]") || meta('meta[property="og:description"]'),
    text: root === null ? "" : textOf(root, maxChars),
    scrollPct: scrollable > 200 ? Math.round((window.scrollY / scrollable) * 100) : null,
    media: video !== null && video.duration > 0 && Number.isFinite(video.duration)
      ? { currentSec: Math.round(video.currentTime), durationSec: Math.round(video.duration) }
      : null,
    selection: window.getSelection()?.toString() ?? ""
  }
}

const Finite = Schema.Number.check(Schema.isFinite())

/** The shape `extractPage` returns, checked before use: a page can't be trusted to keep it. */
export const RawPage = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  headings: Schema.Array(Schema.String),
  description: Schema.String,
  text: Schema.String,
  scrollPct: Schema.NullOr(Finite),
  media: Schema.NullOr(Schema.Struct({ currentSec: Finite, durationSec: Finite })),
  selection: Schema.String
})
export type RawPage = typeof RawPage.Type
