import { Exit, Schema } from "effect"

/** Decodes `input`, returning the value or failing the test with the schema error. */
export const decodeOk = <T, E>(schema: Schema.Codec<T, E>, input: unknown): T => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  if (Exit.isFailure(exit)) throw new Error(`expected to decode, got: ${String(exit.cause)}`)
  return exit.value
}

/** True when `input` is rejected. */
export const rejects = <T, E>(schema: Schema.Codec<T, E>, input: unknown): boolean =>
  Exit.isFailure(Schema.decodeUnknownExit(schema)(input))

/** Encodes `value`, returning the wire form or failing the test. */
export const encodeOk = <T, E>(schema: Schema.Codec<T, E>, value: T): E => {
  const exit = Schema.encodeExit(schema)(value)
  if (Exit.isFailure(exit)) throw new Error(`expected to encode, got: ${String(exit.cause)}`)
  return exit.value
}
