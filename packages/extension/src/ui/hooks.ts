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

/**
 * Renders again at the next local midnight, and at each one after (one timer, set again each
 * time), so what a screen says about today moves on with the calendar. Read the time with
 * `Date.now()` while rendering. A timer that fires early just sets itself again.
 */
export const useNewDay = (): void => {
  const [day, setDay] = useState(0)
  useEffect(() => {
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 0)
    const timer = setTimeout(() => setDay((n) => n + 1), midnight.getTime() - Date.now())
    return () => clearTimeout(timer)
  }, [day])
}
