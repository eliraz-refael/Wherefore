/**
 * URL helpers: redaction for the model, sensitivity, display domain, and the normalisation
 * the matcher compares by. All total: a string that isn't a URL never throws.
 */
import { Option } from "effect"

// The WHATWG URL API exists in every runtime core runs in (Chrome, Node), but TypeScript only
// declares it in the DOM and Node typings, which core must not depend on. This module-scoped
// declaration covers the subset used here and doesn't leak into consumers' globals.
interface WhatwgSearchParams extends Iterable<[string, string]> {
  append(name: string, value: string): void
  delete(name: string): void
  sort(): void
}
interface WhatwgUrl {
  readonly href: string
  readonly protocol: string
  username: string
  password: string
  readonly hostname: string
  pathname: string
  search: string
  hash: string
  readonly searchParams: WhatwgSearchParams
}
declare const URL: {
  new(input: string): WhatwgUrl
  canParse(input: string): boolean
}

const parse = (raw: string): Option.Option<WhatwgUrl> => URL.canParse(raw) ? Option.some(new URL(raw)) : Option.none()

const isWeb = (url: WhatwgUrl): boolean => url.protocol === "http:" || url.protocol === "https:"

// ---------- redaction (what the model may see) ----------

/** Query (and fragment) parameters whose values tend to be secrets. */
const SECRET_PARAM =
  /^(code|token|access_token|refresh_token|id_token|key|api_key|apikey|secret|sk|sig|signature|auth|session|sessionid|password|state|_gl|mcid)$/i
/** Longer values are redacted whatever their name: they are usually tokens or encoded state. */
const MAX_PARAM_VALUE = 64
const MAX_FRAGMENT = 64
const MAX_URL = 300
const MAX_UNPARSEABLE = 200
export const REDACTED = "REDACTED"

const fragmentHasSecret = (hash: string): boolean =>
  hash.slice(1).split("&").some((pair) => SECRET_PARAM.test(pair.split("=")[0] ?? ""))

/**
 * The URL as the model may see it: secret or long query values become `REDACTED`, a long or
 * secret-bearing fragment is dropped, credentials are removed, and the result is capped at 300
 * characters. A string that isn't a URL is only truncated.
 */
export const redactUrl = (raw: string): string =>
  Option.match(parse(raw), {
    onNone: () => raw.slice(0, MAX_UNPARSEABLE),
    onSome: (url) => {
      url.username = ""
      url.password = ""
      const params = [...url.searchParams]
      const redacted = params.map(([name, value]): [string, string] =>
        SECRET_PARAM.test(name) || value.length > MAX_PARAM_VALUE ? [name, REDACTED] : [name, value]
      )
      if (redacted.some(([, value], i) => value !== params[i]?.[1])) {
        url.search = ""
        for (const [name, value] of redacted) url.searchParams.append(name, value)
      }
      if (url.hash.length > MAX_FRAGMENT || fragmentHasSecret(url.hash)) url.hash = REDACTED
      return url.href.slice(0, MAX_URL)
    }
  })

// ---------- sensitivity (pages we never read) ----------

/** Mail, chat, cloud consoles and sign-in pages: their content is never read. */
export const SENSITIVE_HOSTS: ReadonlySet<string> = new Set([
  "mail.google.com",
  "mail.proton.me",
  "outlook.live.com",
  "outlook.office.com",
  "web.whatsapp.com",
  "web.telegram.org",
  "discord.com",
  "app.slack.com",
  "console.aws.amazon.com",
  "signin.aws.amazon.com",
  "accounts.google.com",
  "dashboard.workos.com",
  "signin.workos.com"
])
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"])
const SENSITIVE_PATH = /api[-_]?keys|\/billing|\/password|\/oauth|\/callback/i

/** True for pages whose content must never be read. Anything that isn't a URL counts as sensitive. */
export const isSensitive = (raw: string): boolean =>
  Option.match(parse(raw), {
    onNone: () => true,
    onSome: (url) =>
      LOCAL_HOSTS.has(url.hostname) || SENSITIVE_HOSTS.has(url.hostname) || SENSITIVE_PATH.test(url.pathname)
  })

// ---------- display ----------

/**
 * The domain shown next to a tab's title: the host without `www.` for web pages
 * ("github.com"), `scheme://host` for other URLs with a host ("chrome://settings"),
 * else the scheme ("about", "file"). Empty for a string that isn't a URL.
 */
export const domainOf = (raw: string): string =>
  Option.match(parse(raw), {
    onNone: () => "",
    onSome: (url) => {
      if (isWeb(url)) return url.hostname.replace(/^www\./, "")
      const scheme = url.protocol.slice(0, -1)
      return url.hostname !== "" ? `${scheme}://${url.hostname}` : scheme
    }
  })

// ---------- normalisation (what the matcher compares) ----------

/** Campaign and click-tracking parameters: they never change which page a URL points to. */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|igshid|li_fat_id|mc_cid|mc_eid|_ga|_gl|mcid|_hsenc|_hsmi|mkt_tok|oly_anon_id|oly_enc_id|vero_id|rb_clickid|s_cid)$/i

/**
 * A fragment is an in-page anchor (`#install`), which we drop, unless it looks like a
 * client-side route (`#/projects/42`, `#!/x`, `#inbox/18c2...`), which names a different page.
 */
const normalizeFragment = (hash: string): string => {
  const fragment = hash.slice(1)
  if (!fragment.startsWith("!") && !fragment.includes("/")) return ""
  const route = fragment.replace(/\/+$/, "")
  return route === "" || route === "!" ? "" : `#${route}`
}

/**
 * A key that is equal for two URLs pointing at the same page. Removes tracking parameters,
 * sorts the remaining ones, drops credentials, in-page anchors, trailing slashes and a leading
 * `www.`; the scheme, host, path and every other parameter (including secret ones, which can
 * identify a document) still count. `None` for a string that isn't a URL.
 */
export const normalizeUrl = (raw: string): Option.Option<string> =>
  Option.map(parse(raw), (url) => {
    url.username = ""
    url.password = ""
    const tracking = new Set([...url.searchParams].map(([name]) => name).filter((name) => TRACKING_PARAM.test(name)))
    for (const name of tracking) url.searchParams.delete(name)
    url.searchParams.sort()
    url.hash = normalizeFragment(url.hash)
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    }
    return isWeb(url) ? url.href.replace(/^(https?:\/\/)www\./, "$1") : url.href
  })
