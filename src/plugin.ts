import { Plugin } from "@opencode/plugin"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { setupCabbage } from "./plugin/server.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export const OpencodeCabbage = Plugin.define({
  id: "opencode-cabbage",
  setup: (ctx) => setupCabbage(ctx, packageRoot),
})
