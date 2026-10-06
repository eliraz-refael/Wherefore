import { assert, describe, expect, it } from "@effect/vitest"
import { NATIVE_MESSAGE_MAX_BYTES } from "@wherefore/core"
import { Effect, Exit, Stream } from "effect"
import { decodeFrames, encodeFrame, makeFrameDecoder } from "../src/native/codec.ts"

const frame = (message: unknown): Uint8Array => {
  const encoded = encodeFrame(message)
  assert(encoded._tag === "Success")
  return encoded.success
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Feeds `bytes` to a fresh decoder in the given chunk sizes; returns every message. */
const decodeIn = (bytes: Uint8Array, sizes: (index: number) => number) => {
  const decoder = makeFrameDecoder()
  const messages: Array<unknown> = []
  let offset = 0
  for (let i = 0; offset < bytes.length; i++) {
    const size = Math.max(1, sizes(i))
    const pushed = decoder.push(bytes.subarray(offset, offset + size))
    assert(pushed._tag === "Success")
    messages.push(...pushed.success)
    offset += size
  }
  expect(decoder.end()._tag).toBe("Success")
  return messages
}

describe("native messaging codec", () => {
  it("writes a 4-byte little-endian length, then UTF-8 JSON", () => {
    const bytes = frame({ hi: "é" })
    const body = new TextEncoder().encode(JSON.stringify({ hi: "é" }))
    expect([...bytes.subarray(0, 4)]).toEqual([body.length, 0, 0, 0])
    expect(new TextDecoder().decode(bytes.subarray(4))).toBe('{"hi":"é"}')
    const big = frame({ text: "x".repeat(70_000) })
    expect(new DataView(big.buffer).getUint32(0, true)).toBe(big.length - 4)
  })

  it("reads frames split anywhere: inside the length, inside a multi-byte character, a byte at a time", () => {
    const messages = [{ a: 1 }, { text: "naïve 日本語 🙂" }, [], "plain", 0, null]
    const bytes = concat(...messages.map(frame))
    expect(decodeIn(bytes, () => 1)).toEqual(messages)
    expect(decodeIn(bytes, (i) => [3, 1, 7, 2, 11][i % 5] ?? 1)).toEqual(messages)
    // A split between the two bytes of "ï".
    const one = frame({ text: "ï" })
    const split = one.indexOf(0xc3) + 1
    expect(decodeIn(one, (i) => (i === 0 ? split : one.length))).toEqual([{ text: "ï" }])
  })

  it("reads several frames from one chunk", () => {
    const bytes = concat(frame({ n: 1 }), frame({ n: 2 }), frame({ n: 3 }))
    expect(decodeIn(bytes, () => bytes.length)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it("refuses to write a message over Chrome's 1 MB limit, and writes one exactly at it", () => {
    // `"` + n characters + `"` is n + 2 bytes of JSON.
    const atLimit = encodeFrame("x".repeat(NATIVE_MESSAGE_MAX_BYTES - 2))
    assert(atLimit._tag === "Success")
    expect(atLimit.success.length).toBe(NATIVE_MESSAGE_MAX_BYTES + 4)
    const over = encodeFrame("x".repeat(NATIVE_MESSAGE_MAX_BYTES - 1))
    assert(over._tag === "Failure")
    expect(over.failure).toMatchObject({ _tag: "NativeMessageTooLarge", bytes: NATIVE_MESSAGE_MAX_BYTES + 1, limit: NATIVE_MESSAGE_MAX_BYTES })
    // Multi-byte characters count as bytes, not characters.
    expect(encodeFrame("é".repeat(NATIVE_MESSAGE_MAX_BYTES / 2))._tag).toBe("Failure")
  })

  it("fails on a corrupt stream: bad JSON, bad UTF-8, an absurd length, an empty body", () => {
    const body = (bytes: ReadonlyArray<number>) => Uint8Array.of(bytes.length, 0, 0, 0, ...bytes)
    const failureOf = (bytes: Uint8Array) => {
      const pushed = makeFrameDecoder().push(bytes)
      assert(pushed._tag === "Failure")
      return pushed.failure
    }
    expect(failureOf(body([0x7b, 0x7b]))).toMatchObject({ reason: "invalid_json" })
    expect(failureOf(body([0x22, 0xff, 0x22]))).toMatchObject({ reason: "invalid_json" })
    expect(failureOf(Uint8Array.of(0, 0, 0, 0))).toMatchObject({ reason: "invalid_json" })
    expect(failureOf(Uint8Array.of(0xff, 0xff, 0xff, 0x7f))).toMatchObject({ reason: "too_large" })
  })

  it("fails when the input ends inside a frame", () => {
    const decoder = makeFrameDecoder()
    expect(decoder.push(frame({ a: 1 }).subarray(0, 6))._tag).toBe("Success")
    expect(decoder.end()).toMatchObject({ _tag: "Failure", failure: { reason: "truncated" } })
    const header = makeFrameDecoder()
    header.push(Uint8Array.of(5, 0))
    expect(header.end()._tag).toBe("Failure")
  })

  it.effect("decodes a byte stream, and fails the stream at a truncated end", () =>
    Effect.gen(function*() {
      const bytes = concat(frame({ n: 1 }), frame({ n: 2 }))
      const chunks = Stream.fromIterable([bytes.subarray(0, 5), bytes.subarray(5, 13), bytes.subarray(13)])
      expect(yield* Stream.runCollect(decodeFrames(chunks))).toEqual([{ n: 1 }, { n: 2 }])

      const truncated = yield* Effect.exit(Stream.runCollect(decodeFrames(Stream.make(bytes.subarray(0, 7)))))
      assert(Exit.isFailure(truncated))
      expect(Exit.findErrorOption(truncated)).toMatchObject({ _tag: "Some", value: { _tag: "NativeFrameError", reason: "truncated" } })
    }))
})
