import { defineConfig } from "vitest/config";
import { codecovVitePlugin } from "@codecov/vite-plugin";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        testTimeout: 30000,
    },
    resolve: {
        alias: {
            obsidian: "./tests/__mocks__/obsidian.ts",
        },
    },
    plugins: [
        // Put the Codecov vite plugin after all other plugins
        codecovVitePlugin({
            enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
            bundleName: "obsidian-vault-sync",
            uploadToken: process.env.CODECOV_TOKEN,
        }),
    ],
});
