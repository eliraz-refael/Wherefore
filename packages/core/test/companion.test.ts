import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  BrokerRpcs,
  BrokeredToolError,
  CompanionStatus,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  ExtensionToHost,
  HostToExtension,
  NATIVE_HOST_NAME,
  ProfileId,
  profileIdFromBytes,
  TabToolRpcs
} from "../src/index.ts"
import { decodeOk, rejects } from "./helpers.ts"

const PROFILE = "abcdefghijklmnopqrstuvwxyz"

describe("companion identity", () => {
  it("allows exactly the pinned extension, under a host name Chrome accepts", () => {
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}/`)
    // Chrome: lowercase alphanumerics, underscores and dots; no leading/trailing dot, no "..".
    expect(NATIVE_HOST_NAME).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/)
    expect(NATIVE_HOST_NAME).not.toBe("com.tab_intentions.host")
  })

  it("makes 26-character base32 profile ids from 16 bytes", () => {
    const zeros = profileIdFromBytes(new Uint8Array(16))
    expect(zeros).toBe("a".repeat(26))
    const ones = profileIdFromBytes(new Uint8Array(16).fill(255))
    expect(ones).toBe(`${"7".repeat(25)}4`)
    const mixed = profileIdFromBytes(Uint8Array.from({ length: 16 }, (_, i) => i * 17))
    expect(decodeOk(ProfileId, mixed)).toBe(mixed)
    expect(() => profileIdFromBytes(new Uint8Array(8))).toThrow()
  })

  it("accepts only ids that are safe in file and pipe names", () => {
    expect(decodeOk(ProfileId, PROFILE)).toBe(PROFILE)
    for (const bad of ["", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "../../etc/passwd/aaaaaaaaaa", `${PROFILE}a`, "abcdefghijklmnopqrstuvwxy1"]) {
      expect(rejects(ProfileId, bad)).toBe(true)
    }
  })
})

describe("native port frames", () => {
  it("decodes the handshake and RPC frames in each direction", () => {
    expect(decodeOk(ExtensionToHost, { _tag: "Hello", protocol: 1, profileId: PROFILE, extensionVersion: "0.0.0" }))
      .toMatchObject({ _tag: "Hello", profileId: PROFILE })
    expect(decodeOk(HostToExtension, { _tag: "Welcome", protocol: 1, companionVersion: "0.0.0" }))
      .toMatchObject({ _tag: "Welcome" })
    const request = { _tag: "Request", id: "1", tag: "list_tabs", payload: {}, headers: [] }
    expect(decodeOk(HostToExtension, { _tag: "ToWorker", rpc: request })).toEqual({ _tag: "ToWorker", rpc: request })
    const exit = { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { tabs: [] } } }
    expect(decodeOk(ExtensionToHost, { _tag: "FromWorker", rpc: exit })).toEqual({ _tag: "FromWorker", rpc: exit })
  })

  it("rejects frames sent the wrong way or malformed", () => {
    expect(rejects(HostToExtension, { _tag: "Hello", protocol: 1, profileId: PROFILE, extensionVersion: "0" })).toBe(true)
    expect(rejects(ExtensionToHost, { _tag: "ToWorker", rpc: { _tag: "Ping" } })).toBe(true)
    expect(rejects(ExtensionToHost, { _tag: "Hello", protocol: 1, profileId: "x", extensionVersion: "0" })).toBe(true)
    expect(rejects(HostToExtension, { _tag: "ToWorker", rpc: { _tag: "Request", id: 1 } })).toBe(true)
  })
})

describe("BrokerRpcs", () => {
  it("forwards the worker's tool requests with the same schemas, widening only the error", () => {
    for (const [tag, rpc] of TabToolRpcs.requests) {
      const brokered = BrokerRpcs.requests.get(tag)
      expect(brokered?.payloadSchema).toBe(rpc.payloadSchema)
      expect(brokered?.successSchema).toBe(rpc.successSchema)
      expect(brokered?.errorSchema).toBe(BrokeredToolError)
    }
    expect([...BrokerRpcs.requests.keys()]).toEqual(["broker_info", "list_tabs", "read_pages", "wake_and_read_pages"])
  })

  it("decodes both forwarding errors", () => {
    const decode = Schema.decodeUnknownSync(BrokeredToolError)
    expect(decode({ _tag: "ToolError", message: "x" })._tag).toBe("ToolError")
    expect(decode({ _tag: "ExtensionUnavailable", message: "gone" })._tag).toBe("ExtensionUnavailable")
  })
})

describe("CompanionStatus", () => {
  it("round-trips every state", () => {
    for (
      const status of [
        { _tag: "Checking" },
        { _tag: "NotInstalled" },
        { _tag: "Connected", profileId: PROFILE, companionVersion: "0.0.0", since: 1 },
        { _tag: "Unavailable", reason: "failed", message: "The companion stopped.", retryAt: 5 },
        { _tag: "Unavailable", reason: "incompatible", message: "Update the companion." }
      ]
    ) {
      expect(Schema.encodeSync(CompanionStatus)(decodeOk(CompanionStatus, status))).toEqual(status)
    }
    expect(rejects(CompanionStatus, { _tag: "Unavailable", reason: "nope", message: "" })).toBe(true)
  })
})
