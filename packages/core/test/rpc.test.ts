import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  ListTabs,
  ReadPages,
  RemovedItem,
  Settings,
  StoreRpcs,
  TabRpcs,
  TabToolRpcs,
  ToolError,
  TriageToolkit,
  WakeAndReadPages,
  WorkerRpcs
} from "../src/index.ts"
import { decodeOk, encodeOk, rejects } from "./helpers.ts"

describe("WorkerRpcs", () => {
  it("serves the worker-side tools under their tool names, with the Toolkit's own schemas", () => {
    for (const tool of [ListTabs, ReadPages, WakeAndReadPages]) {
      const rpc = TabToolRpcs.requests.get(tool.name)
      expect(rpc?.payloadSchema).toBe(tool.parametersSchema)
      expect(rpc?.successSchema).toBe(tool.successSchema)
      expect(rpc?.errorSchema).toBe(ToolError)
      expect(Object.keys(TriageToolkit.tools)).toContain(tool.name)
    }
  })

  it("carries a tool call's payload in the model's wire form", () => {
    const payload = TabToolRpcs.requests.get("read_pages")?.payloadSchema
    expect(payload).toBeDefined()
    if (payload === undefined) return
    expect(Schema.decodeUnknownSync(payload)({ tab_ids: [3, 4], max_chars: 500 })).toEqual({ tabIds: [3, 4], maxChars: 500 })
  })

  it("is the merge of the tool, tab and store groups", () => {
    const tags = [...WorkerRpcs.requests.keys()]
    expect(tags).toEqual([...TabToolRpcs.requests.keys(), ...TabRpcs.requests.keys(), ...StoreRpcs.requests.keys()])
    expect(tags).toEqual([
      "list_tabs",
      "read_pages",
      "wake_and_read_pages",
      "close_tabs",
      "undo_close",
      "resume_item",
      "save_items",
      "mark_done",
      "mark_open",
      "remove_item",
      "restore_item",
      "update_settings"
    ])
  })
})

describe("Settings", () => {
  it("accepts an API key and a model, both optional and non-empty", () => {
    expect(decodeOk(Settings, {})).toEqual({})
    expect(decodeOk(Settings, { apiKey: "sk-test", model: "m" })).toEqual({ apiKey: "sk-test", model: "m" })
    expect(rejects(Settings, { apiKey: "" })).toBe(true)
  })
})

describe("RemovedItem", () => {
  it("round-trips, so a remove can be undone through the worker", () => {
    const stored = {
      item: {
        id: "item-1",
        type: "read",
        task: "Read the RFC",
        intention: "Read the RFC",
        why: "",
        tabs: [{ title: "RFC", url: "https://www.rfc-editor.org/rfc/rfc6749", domain: "rfc-editor.org" }],
        status: "open",
        savedAt: "2026-10-04T09:30:00.000Z"
      },
      index: 2
    }
    expect(encodeOk(RemovedItem, decodeOk(RemovedItem, stored))).toEqual(stored)
    expect(rejects(RemovedItem, { ...stored, index: -1 })).toBe(true)
  })
})
