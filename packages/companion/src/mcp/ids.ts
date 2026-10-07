/**
 * Session tab and window ids (architecture A3, "Who sees what").
 *
 * An MCP session can see several Chrome profiles at once, and Chrome's tab and window ids are only
 * unique within one browser (Chrome and Brave, or two Chrome channels, reuse the same numbers).
 * Core's tool schemas take plain integer ids, so instead of changing them the MCP server gives the
 * model its own ids: each (profile, Chrome id) pair gets the next integer the first time the model
 * sees it, and keeps it for the whole session (a tab listed twice has one id). Calls are mapped
 * back before they reach a profile; everything stored in a profile (its run, its intentions) uses
 * that profile's real ids.
 *
 * Pure and synchronous: the session calls it while holding its own state.
 */
import { type ProfileId, TabId, type TabSnapshot, WindowId } from "@wherefore/core"

export interface RealId {
  readonly profile: ProfileId
  readonly id: number
}

/** One kind of id (tabs or windows): (profile, real) <-> session id. */
class IdSpace {
  private readonly toSession = new Map<string, number>()
  private readonly toReal = new Map<number, RealId>()
  private next = 1

  sessionId(profile: ProfileId, id: number): number {
    const key = `${profile}:${id}`
    const known = this.toSession.get(key)
    if (known !== undefined) return known
    const assigned = this.next++
    this.toSession.set(key, assigned)
    this.toReal.set(assigned, { profile, id })
    return assigned
  }

  real(sessionId: number): RealId | undefined {
    return this.toReal.get(sessionId)
  }
}

export class SessionIds {
  private readonly tabs = new IdSpace()
  private readonly windows = new IdSpace()

  /** The session id of a profile's tab. */
  tab(profile: ProfileId, id: TabId): TabId {
    return TabId.make(this.tabs.sessionId(profile, id))
  }

  /** The profile and Chrome id behind a session tab id; undefined for an id the model made up. */
  realTab(sessionId: number): { readonly profile: ProfileId; readonly id: TabId } | undefined {
    const real = this.tabs.real(sessionId)
    return real === undefined ? undefined : { profile: real.profile, id: TabId.make(real.id) }
  }

  /** A profile's tab snapshot as the model sees it: every tab and window id mapped. */
  snapshot(profile: ProfileId, tab: TabSnapshot): TabSnapshot {
    const mapped: TabSnapshot = {
      ...tab,
      id: this.tab(profile, tab.id),
      window: WindowId.make(this.windows.sessionId(profile, tab.window))
    }
    return {
      ...mapped,
      ...(tab.openedFrom === undefined ? {} : { openedFrom: this.tab(profile, tab.openedFrom) }),
      ...(tab.duplicateOf === undefined ? {} : { duplicateOf: this.tab(profile, tab.duplicateOf) })
    }
  }
}
