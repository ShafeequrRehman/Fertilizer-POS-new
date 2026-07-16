import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

// Standard Vite + React + TypeScript flat config, replacing the old
// eslint-config-next setup (which depended on the Next.js compiler and no
// longer applies now that the app is a plain Vite SPA).
export default defineConfig([
  globalIgnores(["dist/**", "node_modules/**", "backend/**", "*.config.*"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
]);
