/**
 * The toast: the outcome of the last action, with Undo when it can be undone. It sits in a
 * polite live region, so screen readers hear it without losing their place.
 *
 * It stays for `TOAST_MS`, longer while the pointer or keyboard focus is on it, and until the next
 * action replaces it.
 */
import { useAtom } from "@effect/atom-react"
import { useEffect, useRef, useState } from "react"
import { toastAtom } from "../atoms.ts"
import { useRun, useToast } from "../hooks.ts"

export const TOAST_MS = 10_000

export function ToastRegion() {
  const [toast, setToast] = useAtom(toastAtom)
  const run = useRun()
  const show = useToast()
  const [held, setHeld] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const region = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (toast === null || held) return
    const timer = setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast, held, setToast])

  const undo = async () => {
    if (toast?.undo === undefined) return
    setUndoing(true)
    const exit = await run(toast.undo)
    setUndoing(false)
    const message = exit._tag === "Success" ? exit.value : "Couldn't undo that."
    show(message)
    // The Undo button is gone; keep focus in the toast rather than dropping it on the page.
    region.current?.querySelector<HTMLElement>(".wf-toast-dismiss")?.focus()
  }

  return (
    <div
      ref={region}
      className="wf-toast-region"
      role="status"
      aria-live="polite"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false)
      }}
    >
      {toast === null ? null : (
        <div className="wf-toast" key={toast.id}>
          <span className="wf-toast-text">{toast.message}</span>
          {toast.undo === undefined ? null : (
            <button type="button" className="wf-toast-undo" onClick={undo} disabled={undoing}>
              Undo
            </button>
          )}
          <button type="button" className="wf-toast-dismiss" aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
