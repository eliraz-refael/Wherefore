/**
 * React glue: run panel Effects with the registry's services, show their outcome in the toast,
 * move focus after an in-place update, and render again when the day changes.
 */
import { RegistryContext, useAtomSet } from "@effect/atom-react"
import { Cause, Effect, Exit, Option } from "effect"
import { useCallback, useContext, useEffect, useState } from "react"
import { Atom, AtomRegistry } from "../unstable.ts"
import { describeError, type Done, type PanelEffect } from "./actions.ts"
import { panelRuntime, toastAtom } from "./atoms.ts"
import { localToday } from "./dates.ts"

/** Runs an Effect on this registry's panel services (built once, kept for the registry's life). */
export const useRun = () => {
  const registry = useContext(RegistryContext)
  return useCallback(
    <A, E>(effect: PanelEffect<A, E>): Promise<Exit.Exit<A, E>> =>
      Effect.runPromiseExit(
        Atom.getResult(panelRuntime).pipe(
          Effect.flatMap((context) => Effect.provideContext(effect, context)),
          Effect.provideService(AtomRegistry.AtomRegistry, registry)
        )
      ),
    [registry]
  )
}

let nextToastId = 1

/** Shows a message in the toast (and the live region), with an optional undo. */
export const useToast = () => {
  const setToast = useAtomSet(toastAtom)
  return useCallback(
    (message: string, undo?: Done["undo"]) =>
      setToast(undo === undefined ? { id: nextToastId++, message } : { id: nextToastId++, message, undo }),
    [setToast]
  )
}

/** What a failed Exit says to the user. */
export const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause)
  return error._tag === "Some" ? describeError(error.value) : describeError(undefined)
}

/**
 * Runs an action. A failure goes to the toast; a success too when `toToast` says what to show
 * (a string, or a `Done` with its undo). Returns the value when it succeeded.
 */
export const useAct = () => {
  const run = useRun()
  const toast = useToast()
  return useCallback(
    async <A, E>(effect: PanelEffect<A, E>, toToast?: (value: A) => Done | string | undefined): Promise<Option.Option<A>> => {
      const exit = await run(effect)
      if (Exit.isFailure(exit)) {
        toast(failureMessage(exit.cause))
        return Option.none()
      }
      const shown = toToast?.(exit.value)
      if (typeof shown === "string") toast(shown)
      else if (shown !== undefined) toast(shown.message, shown.undo)
      return Option.some(exit.value)
    },
    [run, toast]
  )
}

/**
 * Focuses the first element matching `selector` once it is rendered and enabled (React commits
 * after this returns, and an element may move, appear or stop being disabled a frame later). Gives
 * up after a few tries.
 */
export const focusSoon = (selector: string): void => focusWhenThere(() => document.querySelector<HTMLElement>(selector))

/** `focusSoon` by element id (ids may hold characters a selector would need escaped). */
export const focusIdSoon = (id: string): void => focusWhenThere(() => document.getElementById(id))

const focusWhenThere = (find: () => HTMLElement | null): void => {
  let tries = 0
  const attempt = () => {
    const element = find()
    if (element !== null && !element.matches(":disabled")) element.focus()
    else if (tries++ < 10) setTimeout(attempt, 16)
  }
  setTimeout(attempt, 0)
}

/** The user's calendar day at `ms`, as a key. */
const dayKey = (ms: number): string => {
  const { year, month, day } = localToday(ms)
  return `${year}-${month}-${day}`
}

/**
 * Renders again when the local day changes, so what a screen says about today moves on with the
 * calendar: at the next local midnight (one timer, set again each time), and when the panel is
 * shown again or gets focus (a computer that slept through midnight fires the timer late). Read
 * the time with `Date.now()` while rendering. A check on the same day just sets the timer again,
 * from now.
 */
export const useNewDay = (): void => {
  const [day, setDay] = useState(() => dayKey(Date.now()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      const midnight = new Date()
      midnight.setHours(24, 0, 0, 0)
      timer = setTimeout(check, midnight.getTime() - Date.now())
    }
    // A new day renders again, and this effect then sets the timer for the next one.
    const check = () => (dayKey(Date.now()) === day ? schedule() : setDay(dayKey(Date.now())))
    const onVisibility = () => {
      if (document.visibilityState === "visible") check()
    }
    schedule()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", check)
    }
  }, [day])
}
