/**
 * A scripted `LanguageModel`: each request gets the next turn of a script, which sees the prompt
 * so far (to check what the model would have been sent) and answers with response parts or fails.
 * Behind it, the real `ModelClient` runs: `Chat`, the Toolkit and the agent's handlers.
 */
import { Effect, Layer, Stream } from "effect"
import { ModelClient } from "../../src/agent/ModelClient.ts"
import { AiError, LanguageModel, type Prompt, type Response } from "../../src/unstable.ts"

export type Turn = (prompt: Prompt.Prompt) => Effect.Effect<ReadonlyArray<Response.PartEncoded>, AiError.AiError>

export const usage = (input = 1000, output = 200, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: { uncached: input, total: input + cacheRead + cacheWrite, cacheRead, cacheWrite },
  outputTokens: { total: output }
})

export const toolCall = (id: string, name: string, params: unknown): Response.PartEncoded => ({
  type: "tool-call",
  id,
  name,
  params
})

export const text = (value: string): Response.PartEncoded => ({ type: "text", text: value })

export const finish = (reason: Response.FinishReason, tokens = usage()): Response.PartEncoded => ({
  type: "finish",
  reason,
  usage: tokens
})

/** A turn that calls tools, then stops for their results. */
export const callTools = (...calls: ReadonlyArray<Response.PartEncoded>): Turn => () =>
  Effect.succeed([...calls, finish("tool-calls")])

/** A turn that fails with an `AiError` reason. */
export const failWith = (reason: AiError.AiErrorReason): Turn => () =>
  Effect.fail(AiError.make({ module: "Test", method: "generateText", reason }))

/** The tool results in the prompt's last tool message, by tool call id. */
export const toolResults = (prompt: Prompt.Prompt): Map<string, { readonly isFailure: boolean; readonly result: unknown }> => {
  const results = new Map<string, { readonly isFailure: boolean; readonly result: unknown }>()
  const last = [...prompt.content].reverse().find((message) => message.role === "tool")
  if (last?.role !== "tool") return results
  for (const part of last.content) {
    if (part.type === "tool-result") results.set(part.id, { isFailure: part.isFailure, result: part.result })
  }
  return results
}

/** The text of the prompt's last user message. */
export const lastUserText = (prompt: Prompt.Prompt): string => {
  const last = [...prompt.content].reverse().find((message) => message.role === "user")
  if (last?.role !== "user") return ""
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

export class ScriptedModel {
  readonly prompts: Array<Prompt.Prompt> = []
  readonly built: Array<{ readonly apiKey: string; readonly model: string }> = []

  constructor(private readonly turns: ReadonlyArray<Turn>) {}

  get calls(): number {
    return this.prompts.length
  }

  get layer(): Layer.Layer<ModelClient> {
    return ModelClient.layerFrom((options) => {
      this.built.push(options)
      return LanguageModel.make({
        generateText: (request) =>
          Effect.suspend(() => {
            const turn = this.turns[this.prompts.length]
            this.prompts.push(request.prompt)
            return turn === undefined
              ? Effect.die(new Error(`the script has no turn ${this.prompts.length}`))
              : Effect.map(turn(request.prompt), (parts) => [...parts])
          }),
        streamText: () => Stream.die(new Error("not used"))
      })
    })
  }
}
