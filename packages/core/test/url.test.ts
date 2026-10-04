import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { domainOf, isSensitive, normalizeUrl, redactUrl } from "../src/index.ts"

const key = (raw: string): string | undefined => Option.getOrUndefined(normalizeUrl(raw))
const same = (a: string, b: string): boolean => {
  const ka = key(a)
  return ka !== undefined && ka === key(b)
}

describe("redactUrl", () => {
  it("leaves ordinary URLs alone", () => {
    expect(redactUrl("https://github.com/acme/api/pull/412?tab=files#diff-1")).toBe(
      "https://github.com/acme/api/pull/412?tab=files#diff-1"
    )
  })

  it("redacts secret parameters by name, case-insensitively", () => {
    expect(redactUrl("https://app.example/cb?code=abc123&state=xyz&page=2")).toBe(
      "https://app.example/cb?code=REDACTED&state=REDACTED&page=2"
    )
    expect(redactUrl("https://api.example/v1?API_KEY=sk-live-1&Token=t")).toBe(
      "https://api.example/v1?API_KEY=REDACTED&Token=REDACTED"
    )
  })

  it("redacts any value longer than 64 characters", () => {
    const long = "a".repeat(65)
    expect(redactUrl(`https://x.example/?q=${long}&b=${"b".repeat(64)}`)).toBe(
      `https://x.example/?q=REDACTED&b=${"b".repeat(64)}`
    )
  })

  it("keeps repeated parameters", () => {
    expect(redactUrl("https://x.example/?tag=a&token=1&tag=b")).toBe(
      "https://x.example/?tag=a&token=REDACTED&tag=b"
    )
  })

  it("drops long or secret-bearing fragments", () => {
    expect(redactUrl(`https://x.example/#${"f".repeat(64)}`)).toBe("https://x.example/#REDACTED")
    expect(redactUrl("https://x.example/cb#access_token=abc&token_type=bearer")).toBe("https://x.example/cb#REDACTED")
    expect(redactUrl("https://x.example/docs#install")).toBe("https://x.example/docs#install")
  })

  it("removes credentials", () => {
    expect(redactUrl("https://user:hunter2@x.example/admin")).toBe("https://x.example/admin")
  })

  it("caps the length at 300 characters", () => {
    const path = "/p".repeat(200)
    expect(redactUrl(`https://x.example${path}`)).toHaveLength(300)
  })

  it("only truncates strings that aren't URLs", () => {
    expect(redactUrl("not a url")).toBe("not a url")
    expect(redactUrl("x".repeat(250))).toHaveLength(200)
  })
})

describe("isSensitive", () => {
  it.each([
    "https://mail.google.com/mail/u/0/#inbox",
    "https://app.slack.com/client/T1/C2",
    "https://console.aws.amazon.com/ec2",
    "https://accounts.google.com/signin",
    "http://localhost:3000/",
    "http://127.0.0.1:8080/admin",
    "http://[::1]:5173/",
    "https://platform.example/settings/api-keys",
    "https://shop.example/account/billing",
    "https://idp.example/oauth/authorize",
    "https://app.example/auth/callback?code=1",
    "not a url"
  ])("%s is sensitive", (raw) => {
    expect(isSensitive(raw)).toBe(true)
  })

  it.each([
    "https://github.com/acme/api/pull/412",
    "https://docs.google.com/document/d/abc/edit",
    "https://google.com/search?q=mail.google.com",
    "chrome://settings/"
  ])("%s is not sensitive", (raw) => {
    expect(isSensitive(raw)).toBe(false)
  })
})

describe("domainOf", () => {
  it.each([
    ["https://github.com/acme/api", "github.com"],
    ["https://www.rfc-editor.org/rfc/rfc6749", "rfc-editor.org"],
    ["http://WWW.Example.COM:8080/x", "example.com"],
    ["https://docs.www.example/x", "docs.www.example"],
    ["chrome://settings/privacy", "chrome://settings"],
    ["about:blank", "about"],
    ["file:///Users/me/notes.txt", "file"],
    ["not a url", ""]
  ])("%s -> %s", (raw, domain) => {
    expect(domainOf(raw)).toBe(domain)
  })
})

describe("normalizeUrl", () => {
  it("is None for strings that aren't URLs", () => {
    expect(Option.isNone(normalizeUrl(""))).toBe(true)
    expect(Option.isNone(normalizeUrl("github.com/acme"))).toBe(true)
  })

  it("drops tracking parameters", () => {
    expect(key("https://blog.example/post?utm_source=x&utm_medium=email&UTM_Campaign=y&fbclid=1&gclid=2")).toBe(
      "https://blog.example/post"
    )
    expect(same("https://blog.example/post?id=7&mc_cid=a&_gl=b", "https://blog.example/post?id=7")).toBe(true)
  })

  it("keeps parameters that identify the page, including secret-looking ones", () => {
    expect(same("https://github.com/acme/api?ref=main", "https://github.com/acme/api?ref=dev")).toBe(false)
    expect(same("https://www.google.com/search?q=desk", "https://www.google.com/search?q=chair")).toBe(false)
    expect(same("https://docs.example/ccc?key=A", "https://docs.example/ccc?key=B")).toBe(false)
  })

  it("ignores parameter order", () => {
    expect(same("https://x.example/p?b=2&a=1", "https://x.example/p?a=1&b=2")).toBe(true)
  })

  it("drops in-page anchors but keeps client-side routes", () => {
    expect(same("https://docs.example/guide#install", "https://docs.example/guide")).toBe(true)
    expect(same("https://github.com/a/b/issues/1#issuecomment-9", "https://github.com/a/b/issues/1")).toBe(true)
    expect(same("https://app.example/#/projects/42", "https://app.example/#/projects/43")).toBe(false)
    expect(same("https://app.example/#!/inbox", "https://app.example/")).toBe(false)
    expect(same("https://mail.google.com/mail/u/0/#inbox/FMfcgz1", "https://mail.google.com/mail/u/0/#inbox")).toBe(
      false
    )
    expect(same("https://app.example/#/projects/42/", "https://app.example/#/projects/42")).toBe(true)
    expect(same("https://app.example/#/", "https://app.example/")).toBe(true)
  })

  it("ignores trailing slashes, but not other path differences", () => {
    expect(same("https://x.example/docs/", "https://x.example/docs")).toBe(true)
    expect(same("https://x.example/docs//", "https://x.example/docs")).toBe(true)
    expect(same("https://x.example", "https://x.example/")).toBe(true)
    expect(same("https://x.example/Docs", "https://x.example/docs")).toBe(false)
    expect(same("https://x.example/docs/a", "https://x.example/docs")).toBe(false)
  })

  it("ignores host case, default ports, www. and credentials", () => {
    expect(same("HTTPS://WWW.Example.com:443/a", "https://example.com/a")).toBe(true)
    expect(same("https://user:pw@example.com/a", "https://example.com/a")).toBe(true)
    expect(same("https://example.com:8443/a", "https://example.com/a")).toBe(false)
    expect(same("https://docs.example.com/a", "https://example.com/a")).toBe(false)
  })

  it("keeps the scheme", () => {
    expect(same("http://example.com/a", "https://example.com/a")).toBe(false)
  })

  it("drops an empty query", () => {
    expect(same("https://x.example/p?", "https://x.example/p")).toBe(true)
  })

  it("handles non-web URLs", () => {
    expect(same("chrome://settings/privacy/", "chrome://settings/privacy")).toBe(true)
    expect(same("file:///Users/me/a.pdf#page=3", "file:///Users/me/a.pdf")).toBe(true)
    expect(key("about:blank")).toBe("about:blank")
  })
})
