import { describe, expect, it } from "@effect/vitest"
import { type ProfileId, TabId, WindowId } from "@wherefore/core"
import { claudeMcpAdd } from "../src/install/plan.ts"
import { SessionIds } from "../src/mcp/ids.ts"

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaa" as ProfileId
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbb" as ProfileId

describe("session ids", () => {
  it("gives every (profile, tab) its own id for the whole session, and maps it back", () => {
    const ids = new SessionIds()
    const a1 = ids.tab(A, TabId.make(1))
    const b1 = ids.tab(B, TabId.make(1))
    expect(a1).not.toBe(b1)
    expect(ids.tab(A, TabId.make(1))).toBe(a1)
    expect(ids.realTab(b1)).toEqual({ profile: B, id: 1 })
    expect(ids.realTab(999)).toBeUndefined()
  })

  it("maps a snapshot's tab, window, opener and duplicate ids within its profile", () => {
    const ids = new SessionIds()
    const snapshot = ids.snapshot(B, {
      id: TabId.make(7),
      window: WindowId.make(1),
      index: 0,
      title: "t",
      url: "https://example.com/",
      openedFrom: TabId.make(3),
      duplicateOf: TabId.make(5)
    })
    expect(ids.realTab(snapshot.id)).toEqual({ profile: B, id: 7 })
    expect(ids.realTab(snapshot.openedFrom!)).toEqual({ profile: B, id: 3 })
    expect(ids.realTab(snapshot.duplicateOf!)).toEqual({ profile: B, id: 5 })
    expect(ids.snapshot(A, { ...snapshot, window: WindowId.make(1) }).window).not.toBe(snapshot.window)
  })
})

describe("the Claude Code hookup", () => {
  it("registers `mcp` through the launcher, quoting paths that need it", () => {
    expect(claudeMcpAdd({ platform: "darwin", home: "/Users/ada", env: {} })).toBe(
      "claude mcp add --scope user wherefore -- /Users/ada/.wherefore/wherefore mcp"
    )
    expect(claudeMcpAdd({ platform: "linux", home: "/home/me", env: { WHEREFORE_HOME: "/home/me/My State" } })).toBe(
      "claude mcp add --scope user wherefore -- '/home/me/My State/wherefore' mcp"
    )
    expect(claudeMcpAdd({ platform: "win32", home: "C:\\Users\\Ada Lovelace", env: {} })).toBe(
      "claude mcp add --scope user wherefore -- cmd /c \"C:\\Users\\Ada Lovelace\\.wherefore\\wherefore.cmd\" mcp"
    )
  })
})
