import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.next/**",
      "**/storybook-static/**",
      "fixtures/**",
      "bench/.repos/**",
      "eval/.repos/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // `any` needs a justification comment: use eslint-disable-next-line with a reason.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Determinism: localeCompare is locale-dependent; use compareStrings instead.
      "no-restricted-properties": [
        "error",
        {
          property: "localeCompare",
          message: "Use compareStrings from @gitinside/schema (determinism).",
        },
      ],
    },
  },
  {
    // The viewer runs in the browser.
    files: ["packages/viewer/src/**", "packages/viewer/.storybook/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Tests index into known fixtures; non-null assertions keep them readable.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  prettier,
);
