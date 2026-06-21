import globals from "globals";
import js from "@eslint/js";

/**
 * MadMusic is a mixed tree, so environments are split:
 *  - Node backend (ESM): root *.js, lib/, routes/, scripts/, tests/  (package.json is type:module)
 *  - Browser classic scripts: public/js/*.js + public/app.min.js  (window/document globals, load-order, no import/export)
 *  - Browser ESM: public/js/mobile/*.js  (real modules)
 */
export default [
  js.configs.recommended,

  // Honor the `_`-prefix convention for intentionally-unused params/vars/catches
  // (e.g. legacy wrapper signatures kept for call-site compatibility).
  {
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },

  // Global ignores (generated / vendor / runtime).
  {
    ignores: [
      "node_modules/**",
      "data/**",
      "test-results/**",
      "playwright-report/**",
      "blob-report/**",
      ".playwright/**",
      "coverage/**",
    ],
  },

  // Node backend (ESM). Note: **/*.js does NOT match .mjs/.cjs in flat config.
  {
    files: ["**/*.{js,mjs,cjs}"],
    ignores: ["public/**"],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
      ecmaVersion: "latest",
    },
  },

  // Playwright specs run in Node but page.evaluate() callbacks use browser globals.
  {
    files: ["tests/**/*.spec.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      sourceType: "module",
      ecmaVersion: "latest",
    },
  },

  // Browser classic scripts (desktop) — load-order globals, NOT modules.
  {
    files: ["public/**/*.js"],
    ignores: ["public/js/mobile/**"],
    languageOptions: {
      globals: globals.browser,
      sourceType: "script",
      ecmaVersion: "latest",
    },
  },

  // Browser ESM (mobile).
  {
    files: ["public/js/mobile/**/*.js"],
    languageOptions: {
      globals: globals.browser,
      sourceType: "module",
      ecmaVersion: "latest",
    },
  },
];
