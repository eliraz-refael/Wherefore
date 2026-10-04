import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { corePackageName, packageName } from "../src/index.ts"
import { ChildProcess, Command, McpServer, RpcGroup, RpcServer, SocketServer } from "../src/unstable.ts"

describe("companion smoke", () => {
  it.effect("links @tab-intentions/core through the workspace", () =>
    Effect.sync(() => {
      expect(corePackageName).toBe("@tab-intentions/core")
      expect(packageName).toBe("@tab-intentions/companion")
    }))

  it("resolves the effect/unstable/{ai,cli,process,rpc,socket} seams", () => {
    expect(McpServer.layerStdio).toBeTypeOf("function")
    expect(Command.make).toBeTypeOf("function")
    expect(ChildProcess.make).toBeTypeOf("function")
    expect(RpcGroup.make).toBeTypeOf("function")
    expect(RpcServer.make).toBeTypeOf("function")
    expect(SocketServer.SocketServer).toBeDefined()
  })
})
