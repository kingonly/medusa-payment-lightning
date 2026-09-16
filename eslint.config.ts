import { defineConfig } from "eslint/config"
import medusa from "@medusajs/eslint-plugin"

export default defineConfig([
  { ignores: ["demo/**", "dist/**", ".medusa/**"] },
  ...medusa.configs.recommended,
])
