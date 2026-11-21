import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"
import { plugin as shadcn } from "@shadcn/lint"
import tsParser from "@typescript-eslint/parser"
import { defineConfig, globalIgnores } from "eslint/config"

const overlayMessage =
  "Phones need a bottom sheet: use ActionMenu (a list of actions or a single choice) or ResponsivePanel (a panel of controls) from src/components/app instead of the Popover/DropdownMenu/Drawer primitives."

const designMessage =
  "Stemora design rules: use semantic tokens (bg-card, text-muted-foreground, bg-stem, ...) and component variants. Tokens and custom utilities (@utility) live in src/index.css; add one there instead of using raw values."

export default defineConfig([
  globalIgnores(["dist", "public", "node_modules"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { shadcn },
    settings: { shadcn: { note: designMessage } },
    rules: {
      "shadcn/no-restyle": [
        "error",
        {
          allow: ["layout"],
          contracts: [
            {
              // Width is layout (w-full, flex-1); height is the touch target, which the size variants keep at 44px on touch screens.
              pattern: "^(Button|Toggle)$",
              allow: ["layout"],
              deny: ["size-*", "h-*", "min-h-*", "max-h-*", "*:size-*", "*:h-*", "*:min-h-*", "*:max-h-*"],
              message:
                "{{component}} owns its height so touch targets stay at least 44px on touch screens. Pick a size variant from {{file}} instead of setting size-* or h-* (add a variant there if the design needs a new one).",
            },
          ],
        },
      ],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/require-static-classes": "error",
      "no-restricted-imports": [
        "error",
        {
          // Matches the @/ alias and relative paths alike
          patterns: [{ group: ["**/components/ui/popover", "**/components/ui/dropdown-menu", "**/components/ui/drawer"], message: overlayMessage }],
        },
      ],
    },
  },
  {
    // The responsive wrappers are the only app code that may use the overlay primitives directly
    files: ["src/components/ui/**", "src/components/app/action-menu.tsx", "src/components/app/responsive-panel.tsx"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Component sources own their styling (shadcn convention)
    files: ["src/components/ui/**"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    // Dev-only mock server, scripts and tooling are not UI
    files: ["mock/**", "scripts/**", "*.config.{js,ts}"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-raw-colors": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/no-inline-styles": "off",
      "shadcn/no-unknown-classes": "off",
      "shadcn/require-static-classes": "off",
    },
  },
])
