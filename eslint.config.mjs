import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "test/", "scripts/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "no-constant-condition": ["error", { checkLoops: false }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": ["warn", "properties"],
    },
  },
  {
    files: ["test/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);
