// The Obsidian community directory reviews plugins with eslint-plugin-obsidianmd's
// recommended rules. Run from the repository root: `npm run lint:obsidian`.
import { fileURLToPath } from "node:url";
import obsidianmd from "eslint-plugin-obsidianmd";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default [
    {
        ignores: [
            "node_modules/**",
            "dist/**",
            "coverage/**",
            "www/**",
            "doc/**",
            "tests/**",
            "tools/**",
            "formal/**",
            "e2e/**",
            "**/*.test.ts",
            "*.config.*",
            "*.mjs",
            "rollup.config.js",
        ],
    },
    ...obsidianmd.configs.recommended,
    {
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: root },
        },
    },
];
