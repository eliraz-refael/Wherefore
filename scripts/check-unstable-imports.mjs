#!/usr/bin/env node
/**
 * Fails when a file in packages/<pkg>/src or packages/<pkg>/test imports `effect/unstable/*`
 * anywhere but that package's own src/unstable.ts (architecture A1: unstable Effect modules sit
 * behind one re-export file per package, so moving to Effect 4.0.0's paths changes one file).
 * `@effect/ai-anthropic` is held to the same rule: it is built on `effect/unstable/ai` and moves
 * with it.
 *
 * Catches static imports and re-exports (`from "..."`), side-effect imports, dynamic `import()`
 * and `require()`. Plain Node, no dependencies, no shell: runs the same on Linux, macOS and Windows.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packagesDir = join(root, "packages")
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const SCANNED_DIRS = ["src", "test"]
const ALLOWED = join("src", "unstable.ts")

// `from "x"`, `import "x"`, `import("x")`, `require("x")`, where x is effect/unstable or
// @effect/ai-anthropic, or below either.
const UNSTABLE_IMPORT =
  /\b(?:from|import|require)\s*\(?\s*(["'`])((?:effect\/unstable|@effect\/ai-anthropic)(?:\/[^"'`\s]*)?)\1/g

/** Every source file under `dir`, skipping node_modules. */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) yield path
  }
}

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const violations = []
let scanned = 0
for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue
  const pkgDir = join(packagesDir, pkg.name)
  for (const scannedDir of SCANNED_DIRS) {
    const dir = join(pkgDir, scannedDir)
    if (!isDir(dir)) continue
    for (const file of sourceFiles(dir)) {
      scanned++
      if (relative(pkgDir, file) === ALLOWED) continue
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(UNSTABLE_IMPORT)) {
        const line = text.slice(0, match.index).split("\n").length
        violations.push(`${relative(root, file).split(sep).join("/")}:${line}: imports "${match[2]}"`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error("effect/unstable/* and @effect/ai-anthropic may only be imported from each package's src/unstable.ts:\n")
  for (const violation of violations) console.error(`  ${violation}`)
  console.error("\nRe-export what you need from that package's src/unstable.ts and import it from there.")
  process.exit(1)
}
console.log(`Unstable import check passed (${scanned} files in packages/*/{src,test}).`)
