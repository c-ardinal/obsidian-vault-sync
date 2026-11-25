import { defineConfig } from "vitest/config";

/**
 * Tests that run the shipped code in a real browser engine (Chromium through
 * Playwright). Needs a browser: npx playwright-core install chromium
 */
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/browser/**/*.test.ts"],
        testTimeout: 30000,
        hookTimeout: 60000,
    },
    resolve: {
        alias: { obsidian: "./tests/browser/obsidian-stub.ts" },
    },
});
