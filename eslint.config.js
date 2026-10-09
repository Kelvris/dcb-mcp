// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Leading underscore = intentionally unused (guards often ignore a param).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      // stdout is the JSON-RPC channel — anything on it corrupts the protocol.
      // console.warn/console.error go to stderr, so they stay allowed.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
);
