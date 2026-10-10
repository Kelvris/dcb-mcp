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
  {
    // `serializers/internal.ts` holds how the serializers are built, not an API.
    // The barrel is the only sanctioned way in: if a tool or guard reached past
    // it, every helper rename becomes a breaking change across the codebase.
    //
    // The serializers themselves are exempt — that is where the helpers live —
    // and `test/` is deliberately left uncovered: white-box testing of a
    // private helper is legitimate, and the tests are the ones we want to be
    // able to break it.
    //
    // Two rules, because they cover disjoint syntax: `no-restricted-imports`
    // matches static import/export declarations, and `no-restricted-syntax`
    // picks up the dynamic `import()` it does not see.
    files: ["src/**/*.ts"],
    ignores: ["src/discord/serializers/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/serializers/internal.js",
                "**/serializers/internal.ts",
              ],
              message:
                "Import the serializer barrel (src/discord/serializers/index.js) instead — internal.ts is not public API.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression > Literal[value=/serializers[\\\\/]internal/]",
          message:
            "Import the serializer barrel (src/discord/serializers/index.js) instead — internal.ts is not public API.",
        },
      ],
    },
  },
);
