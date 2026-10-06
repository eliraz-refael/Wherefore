/**
 * The host's end of Chrome's native-messaging port: decoded messages from stdin, and one writer
 * that owns stdout. Built on Effect's `Stdio`, so tests drive it in memory.
 *
 * Stdout carries frames and nothing else: every write goes through `send`, which encodes a
 * whole frame first (codec.ts) and fails, writing nothing, when it is over Chrome's limit.
 */
import { type Cause, Duration, Effect, Fiber, Queue, Scope, Stdio, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { decodeFrames, encodeFrame, type NativeFrameError, type NativeMessageTooLarge } from "./codec.ts"

export interface NativePort {
  /** The extension's messages as parsed JSON (not yet schema-checked). Ends when Chrome closes stdin. */
  readonly incoming: Stream.Stream<unknown, NativeFrameError | PlatformError>
  /** Queues one message for Chrome. Fails, writing nothing, when it is over 1 MB. */
  readonly send: (message: unknown) => Effect.Effect<void, NativeMessageTooLarge>
  /**
   * Stops accepting messages and waits (up to a second) until the queued ones are written, so a
   * last message, like a `Welcome` before an early exit, isn't lost.
   */
  readonly close: Effect.Effect<void>
}

export const makeNativePort: Effect.Effect<NativePort, never, Stdio.Stdio | Scope.Scope> = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const frames = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const writer = yield* Stream.fromQueue(frames).pipe(
    Stream.run(stdio.stdout()),
    Effect.catch((error) => Effect.logError(`native port: writing to Chrome failed: ${error.message}`)),
    Effect.forkScoped
  )
  return {
    incoming: decodeFrames(stdio.stdin),
    send: (message) =>
      Effect.suspend(() => {
        const frame = encodeFrame(message)
        return frame._tag === "Failure" ? Effect.fail(frame.failure) : Effect.asVoid(Queue.offer(frames, frame.success))
      }),
    close: Queue.end(frames).pipe(
      Effect.andThen(Fiber.join(writer)),
      Effect.timeoutOption(Duration.seconds(1)),
      Effect.asVoid
    )
  }
})
