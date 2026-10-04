import { Effect } from "effect"
import { browser } from "wxt/browser"
import { Atom } from "../../unstable.ts"

/**
 * The running extension's version, read through an Effect. The M1 shell's only state: it proves
 * that Effect, Atom and @effect/atom-react work end to end in the side panel bundle.
 */
export const versionAtom = Atom.make(Effect.sync(() => browser.runtime.getManifest().version))
