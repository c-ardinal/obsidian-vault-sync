import { defineConfig } from "vitest/config";

/**
 * Multi-device sync simulation (tests/sim). Run with `npm run test:sim`.
 * Env: SIM_SEEDS, SIM_SEED_BASE, SIM_SEED, SIM_SCENARIO, SIM_MINIMIZE(_KIND), SIM_REPORT_DIR
 * See tests/sim/README.md.
 */
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/sim/**/*.test.ts"],
        testTimeout: 300_000,
        setupFiles: ["tests/sim/setup.ts"],
    },
    resolve: {
        alias: {
            obsidian: "./tests/__mocks__/obsidian.ts",
        },
    },
});
