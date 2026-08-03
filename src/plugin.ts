import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeCabbage } from "./plugin/server.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export const OpencodeCabbage: Plugin = createOpencodeCabbage(packageRoot)
