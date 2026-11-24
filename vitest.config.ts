import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // Multi-device simulation has its own config / CI job (vitest.sim.config.ts)
        exclude: ["**/node_modules/**", "tests/sim/**"],
        testTimeout: 30000,
        setupFiles: ["tests/setup-window.ts", "tests/setup-config-dir.ts"],
        coverage: {
            reporter: ["text", "lcov"],
            include: ["src/**/*.ts"],
            exclude: [
                // Barrel re-exports (実体は各モジュールでカバー済み)
                "src/sync-manager/index.ts",
                "src/sync-manager/sync-orchestration.ts",
                // Static data
                "src/i18n/lang/**",
                // Obsidian UI components (require Obsidian DOM runtime)
                "src/ui/**",
                "src/main.ts",
                // Pure type definitions (no runtime code)
                "src/types/**",
                "src/sync-manager/types.ts",
                "src/sync-manager/context.ts",
                "src/encryption/interfaces.ts",
                // Obsidian-dependent services (require App instance)
                "src/services/obsidian-vault-operations.ts",
                "src/services/settings-manager.ts",
                // Strategy interface (pure type)
                "src/sync-manager/strategies/merge-strategy.ts",
            ],
        },
    },
    resolve: {
        alias: {
            obsidian: "./tests/__mocks__/obsidian.ts",
        },
    },
});
