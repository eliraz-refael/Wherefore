/**
 * Chrome's native-messaging framing (architecture A1: "keep ours"): every message is a 4-byte
 * little-endian length, then that many bytes of UTF-8 JSON, over the host's stdin and stdout.
 *
 * - Incoming bytes arrive in arbitrary chunks: a frame can be split anywhere (inside the length,
 *   inside a multi-byte character), and one chunk can hold several frames. `makeFrameDecoder`
 *   handles both, and `decodeFrames` lifts it onto a `Stream`.
 * - Chrome refuses a message from the host above 1 MB and drops the connection. `encodeFrame`
 *   fails with `NativeMessageTooLarge` instead, so a bad frame is never written.
 *
 * Nothing here touches stdout: the host writes frames through one writer (NativePort.ts), and
 * logs go to stderr.
 */
import { NATIVE_MESSAGE_MAX_BYTES } from "@wherefore/core"
import { Effect, Result, Schema, Stream } from "effect"

/** Chrome's own limit on a message to the host (64 MiB). A longer length means a corrupt stream. */
export const INCOMING_MAX_BYTES = 64 * 1024 * 1024

/** The incoming byte stream isn't valid native messaging; the channel can't be trusted after it. */
export class NativeFrameError extends Schema.TaggedError<NativeFrameError>()("NativeFrameError", {
  reason: Schema.Literals(["invalid_json", "too_large", "truncated"]),
  message: Schema.String
}) {}

/** A message for Chrome is over its 1 MB limit; nothing was written. */
export class NativeMessageTooLarge extends Schema.TaggedError<NativeMessageTooLarge>()("NativeMessageTooLarge", {
  bytes: Schema.Int,
  limit: Schema.Int
}) {}

const encoder = new TextEncoder()

/**
 * One frame for Chrome: the length header and the JSON body. Fails when the body is over `limit`
 * bytes (Chrome's 1 MB by default). A value JSON can't represent is a bug, not an input, and dies.
 */
export const encodeFrame = (
  message: unknown,
  limit: number = NATIVE_MESSAGE_MAX_BYTES
): Result.Result<Uint8Array, NativeMessageTooLarge> => {
  const json = JSON.stringify(message)
  if (json === undefined) throw new Error("native messaging: the message has no JSON form")
  const body = encoder.encode(json)
  if (body.length > limit) return Result.fail(new NativeMessageTooLarge({ bytes: body.length, limit }))
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, true)
  frame.set(body, 4)
  return Result.succeed(frame)
}

export interface FrameDecoder {
  /** Feeds a chunk; returns every message it completed (possibly none). */
  readonly push: (chunk: Uint8Array) => Result.Result<ReadonlyArray<unknown>, NativeFrameError>
  /** The input ended: fails if it stopped inside a frame. */
  readonly end: () => Result.Result<void, NativeFrameError>
}

/** A stateful decoder for one byte stream. After a failure the stream is corrupt; stop feeding it. */
export const makeFrameDecoder = (maxBytes: number = INCOMING_MAX_BYTES): FrameDecoder => {
  const header = new Uint8Array(4)
  let headerFilled = 0
  let body: Uint8Array | undefined
  let bodyFilled = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })

  const parse = (bytes: Uint8Array): Result.Result<unknown, NativeFrameError> => {
    try {
      return Result.succeed(JSON.parse(decoder.decode(bytes)) as unknown)
    } catch (cause) {
      return Result.fail(new NativeFrameError({ reason: "invalid_json", message: `a frame isn't UTF-8 JSON: ${String(cause)}` }))
    }
  }

  const push = (chunk: Uint8Array): Result.Result<ReadonlyArray<unknown>, NativeFrameError> => {
    const messages: Array<unknown> = []
    let offset = 0
    while (offset < chunk.length) {
      if (body === undefined) {
        const take = Math.min(4 - headerFilled, chunk.length - offset)
        header.set(chunk.subarray(offset, offset + take), headerFilled)
        headerFilled += take
        offset += take
        if (headerFilled < 4) break
        const length = new DataView(header.buffer).getUint32(0, true)
        if (length > maxBytes) {
          return Result.fail(new NativeFrameError({ reason: "too_large", message: `a frame claims ${length} bytes (limit ${maxBytes})` }))
        }
        body = new Uint8Array(length)
        bodyFilled = 0
      }
      const take = Math.min(body.length - bodyFilled, chunk.length - offset)
      body.set(chunk.subarray(offset, offset + take), bodyFilled)
      bodyFilled += take
      offset += take
      if (bodyFilled < body.length) break
      const parsed = parse(body)
      if (parsed._tag === "Failure") return Result.fail(parsed.failure)
      messages.push(parsed.success)
      body = undefined
      headerFilled = 0
    }
    return Result.succeed(messages)
  }

  const end = (): Result.Result<void, NativeFrameError> =>
    headerFilled === 0 && body === undefined
      ? Result.void
      : Result.fail(new NativeFrameError({ reason: "truncated", message: "the input ended inside a frame" }))

  return { push, end }
}

/** The messages in a byte stream, in order. Fails on a corrupt frame, or if the input ends inside one. */
export const decodeFrames = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number = INCOMING_MAX_BYTES
): Stream.Stream<unknown, E | NativeFrameError, R> =>
  Stream.suspend(() => {
    const decoder = makeFrameDecoder(maxBytes)
    return bytes.pipe(
      Stream.mapEffect((chunk) => Effect.fromResult(decoder.push(chunk))),
      Stream.flattenIterable,
      // Checked when the input ends, not when the pipeline is built.
      Stream.concat(Stream.unwrap(Effect.suspend(() => Effect.as(Effect.fromResult(decoder.end()), Stream.empty))))
    )
  })
