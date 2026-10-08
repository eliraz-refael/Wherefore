// Bundles the CLI into one runnable file, dist/cli.js (Node 22+, ESM, no runtime dependencies),
// so `install` can point Chrome at a single file. The workspace's TypeScript (core included) is
// compiled in; Node's built-ins stay imports. It is also the published package's `bin`, so it is
// made executable. No source map: it would ship this machine's paths.
import { chmodSync } from "node:fs"
import { builtinModules } from "node:module"
import { defineConfig } from "rolldown"

export default defineConfig({
  input: "src/cli.ts",
  platform: "node",
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), /^node:/],
  output: {
    file: "dist/cli.js",
    format: "esm",
    banner: "#!/usr/bin/env node",
    codeSplitting: false
  },
  plugins: [{ name: "executable", writeBundle: (options) => chmodSync(options.file ?? "dist/cli.js", 0o755) }]
})
