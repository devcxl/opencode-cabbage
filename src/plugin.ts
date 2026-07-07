import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeCabbage } from "./plugin/server.js"

export function resolvePackageRoot(metaUrl: string) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..")
}

const packageRoot = resolvePackageRoot(import.meta.url)

export const OpencodeCabbage: Plugin = createOpencodeCabbage(packageRoot)
