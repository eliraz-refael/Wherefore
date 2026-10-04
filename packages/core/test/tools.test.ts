import { describe, expect, it } from "@effect/vitest"
import { Context, Exit, JsonSchema, Schema, SchemaRepresentation } from "effect"
import { type ToolJsonSchema, TriageToolkit, type TriageToolName, toolJsonSchemas } from "../src/index.ts"
import { Tool } from "../src/unstable.ts"

const schemas = toolJsonSchemas()
const byName = new Map<string, ToolJsonSchema>(schemas.map((tool) => [tool.name, tool]))

const input = (name: string): JsonSchema.JsonSchema => {
  const tool = byName.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.inputSchema
}

// ---------- structural validity ----------

/** The draft 2020-12 keywords the generated schemas may use; anything else is a bug or a surprise. */
const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "$comment",
  "type", "enum", "const", "anyOf", "oneOf", "allOf", "not",
  "properties", "required", "additionalProperties", "patternProperties", "propertyNames",
  "minProperties", "maxProperties",
  "items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains",
  "minLength", "maxLength", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "title", "description", "default", "examples", "readOnly", "writeOnly", "deprecated"
])
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Returns every problem found in a JSON Schema node and its children, with a JSON-pointer-ish path. */
const problems = (node: unknown, path: string, defs: Readonly<Record<string, unknown>>): Array<string> => {
  if (typeof node === "boolean") return []
  if (!isRecord(node)) return [`${path}: not a schema`]
  const found: Array<string> = []
  for (const [keyword, value] of Object.entries(node)) {
    if (!KNOWN_KEYWORDS.has(keyword)) found.push(`${path}: unknown keyword ${keyword}`)
    if (keyword === "type") {
      const types = Array.isArray(value) ? value : [value]
      for (const type of types) if (!JSON_TYPES.has(String(type))) found.push(`${path}: bad type ${String(type)}`)
    }
    if (keyword === "required") {
      const props = isRecord(node["properties"]) ? node["properties"] : {}
      if (!Array.isArray(value)) found.push(`${path}: required is not an array`)
      else for (const name of value) if (!(String(name) in props)) found.push(`${path}: required ${String(name)} has no property`)
    }
    if (keyword === "enum" && (!Array.isArray(value) || value.length === 0)) found.push(`${path}: empty enum`)
    if (keyword === "$ref") {
      const name = typeof value === "string" ? value.replace(/^#\/\$defs\//, "") : ""
      if (!(name in defs)) found.push(`${path}: unresolved $ref ${String(value)}`)
    }
    if (["minItems", "maxItems", "minLength", "maxLength"].includes(keyword)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) found.push(`${path}: bad ${keyword}`)
    }
    if (keyword === "properties" || keyword === "$defs") {
      if (!isRecord(value)) found.push(`${path}: ${keyword} is not an object`)
      else for (const [name, child] of Object.entries(value)) found.push(...problems(child, `${path}/${keyword}/${name}`, defs))
    }
    if (["items", "additionalProperties", "not", "contains", "propertyNames"].includes(keyword)) {
      found.push(...problems(value, `${path}/${keyword}`, defs))
    }
    if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(keyword)) {
      if (!Array.isArray(value) || value.length === 0) found.push(`${path}: ${keyword} must be a non-empty array`)
      else value.forEach((child, i) => found.push(...problems(child, `${path}/${keyword}/${i}`, defs)))
    }
  }
  return found
}

const validate = (schema: JsonSchema.JsonSchema): Array<string> =>
  problems(schema, "#", isRecord(schema["$defs"]) ? schema["$defs"] : {})

/** Rebuilds a runtime schema from a generated JSON Schema, to check it accepts and rejects what it should. */
const fromJsonSchema = (schema: JsonSchema.JsonSchema) =>
  SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema))

const accepts = (schema: Schema.Top, value: unknown): boolean =>
  Exit.isSuccess(Schema.decodeUnknownExit(Schema.toType(schema))(value))

// ---------- wire samples (what a model would send) ----------

const intention = {
  title: "Finish reviewing the auth PR",
  why: "Review requested",
  next_step: "Approve #412",
  kind: "work",
  tab_ids: [1, 2],
  confidence: "high",
  evidence: "PR open"
}

// Typed by tool name, so a new tool without samples fails to compile.
const samples: Record<TriageToolName, { readonly good: ReadonlyArray<unknown>; readonly bad: ReadonlyArray<unknown> }> = {
  list_tabs: { good: [{}], bad: [{ extra: 1 }] },
  read_pages: {
    good: [{ tab_ids: [1] }, { tab_ids: [1, 2, 3], max_chars: 3000 }],
    bad: [{}, { tab_ids: [] }, { tab_ids: Array.from({ length: 21 }, (_, i) => i) }, { tab_ids: [1], max_chars: 100 },
      { tab_ids: [1.5] }, { tab_ids: [-1] }]
  },
  wake_and_read_pages: {
    good: [{ tab_ids: Array.from({ length: 10 }, (_, i) => i) }],
    bad: [{ tab_ids: Array.from({ length: 11 }, (_, i) => i) }, { tab_ids: [1], max_chars: 6001 }]
  },
  ask_user: {
    good: [{ questions: [{ id: "q1", tab_ids: [4], question: "Still deciding?", options: ["Yes", "No"] }] }],
    bad: [
      { questions: [] },
      { questions: [{ id: "q1", tab_ids: [], question: "Still deciding?", options: [] }] },
      { questions: [{ id: "q1", tab_ids: [4], question: "?", options: ["a", "b", "c", "d", "e"] }] },
      { questions: [{ id: "q1", question: "Which tab?", options: [] }] }
    ]
  },
  submit_intentions: {
    good: [{ intentions: [intention] }, { intentions: [{ ...intention, next_step: undefined, kind: "dead" }] }],
    bad: [{ intentions: [] }, { intentions: [{ ...intention, kind: "shopping" }] }, { intentions: [{ ...intention, tab_ids: [] }] },
      { intentions: [{ ...intention, confidence: 1 }] }]
  }
}
// JSON drops undefined, as the wire would.
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe("TriageToolkit", () => {
  it("has the five POC tools, in order", () => {
    expect(Object.keys(TriageToolkit.tools)).toEqual([
      "list_tabs",
      "read_pages",
      "wake_and_read_pages",
      "ask_user",
      "submit_intentions"
    ])
  })

  it("returns failures to the model instead of failing the run", () => {
    for (const tool of Object.values(TriageToolkit.tools)) expect(tool.failureMode).toBe("return")
  })

  it("marks only list_tabs, read_pages and ask_user read-only, and nothing destructive", () => {
    const readonly = Object.values(TriageToolkit.tools)
      .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
      .map((tool) => tool.name)
    expect(readonly).toEqual(["list_tabs", "read_pages", "ask_user"])
    for (const tool of Object.values(TriageToolkit.tools)) {
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false)
      expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false)
    }
  })

  it("decodes wire parameters into camelCase domain values", () => {
    const params = Schema.decodeUnknownSync(TriageToolkit.tools.read_pages.parametersSchema)({ tab_ids: [3], max_chars: 900 })
    expect(params).toEqual({ tabIds: [3], maxChars: 900 })
  })
})

describe("tool JSON Schemas", () => {
  it("covers every tool with a description", () => {
    expect(schemas.map((tool) => tool.name)).toEqual(Object.keys(TriageToolkit.tools))
    for (const tool of schemas) expect(tool.description.length).toBeGreaterThan(20)
  })

  it("are valid draft 2020-12 schemas using only known keywords", () => {
    for (const tool of schemas) {
      expect(validate(tool.inputSchema), `${tool.name} input`).toEqual([])
      expect(validate(tool.outputSchema), `${tool.name} output`).toEqual([])
    }
  })

  it("are plain JSON", () => {
    for (const tool of schemas) expect(wire(tool)).toEqual(tool)
  })

  it("have object roots, as tool inputs and MCP outputSchema require", () => {
    for (const tool of schemas) {
      expect(tool.inputSchema["type"], `${tool.name} input`).toBe("object")
      expect(tool.outputSchema["type"], `${tool.name} output`).toBe("object")
    }
  })

  it("show the model snake_case keys", () => {
    const props = (schema: JsonSchema.JsonSchema) => Object.keys(isRecord(schema["properties"]) ? schema["properties"] : {})
    expect(props(input("read_pages"))).toEqual(["tab_ids", "max_chars"])
    const intentionSchema = JSON.stringify(input("submit_intentions"))
    expect(intentionSchema).toContain("\"next_step\"")
    expect(intentionSchema).toContain("\"tab_ids\"")
    expect(intentionSchema).not.toContain("nextStep")
    expect(intentionSchema).not.toContain("tabIds")
  })

  it("carry the parameter descriptions", () => {
    const intentionSchema = JSON.stringify(input("submit_intentions"))
    expect(intentionSchema).toContain("Action-oriented, specific.")
    expect(intentionSchema).toContain("The one-line task the person would write")
    expect(JSON.stringify(input("ask_user"))).toContain("2-4 likely answers")
  })

  it.each(Object.entries(samples))("%s: the JSON Schema and the Effect schema agree on wire samples", (name, { good, bad }) => {
    const fromJson = fromJsonSchema(input(name))
    const tool = Object.values(TriageToolkit.tools).find((t) => t.name === name)
    if (tool === undefined) throw new Error(`no tool ${name}`)
    for (const sample of good.map(wire)) {
      expect(accepts(fromJson, sample), `JSON Schema accepts ${JSON.stringify(sample)}`).toBe(true)
      expect(Exit.isSuccess(Schema.decodeUnknownExit(tool.parametersSchema)(sample))).toBe(true)
    }
    for (const sample of bad.map(wire)) {
      expect(Exit.isFailure(Schema.decodeUnknownExit(tool.parametersSchema, { onExcessProperty: "error" })(sample)),
        `Effect schema rejects ${JSON.stringify(sample)}`).toBe(true)
      expect(accepts(fromJson, sample), `JSON Schema rejects ${JSON.stringify(sample)}`).toBe(false)
    }
  })

  it("are stable", async () => {
    await expect(`${JSON.stringify(schemas, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/tool-json-schemas.json")
  })
})
