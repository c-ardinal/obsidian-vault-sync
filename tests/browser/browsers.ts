import { build } from "esbuild";
import { chromium, webkit, type Browser } from "playwright-core";

/**
 * Browser engines the tests run in: Chromium (Obsidian desktop is Electron, Android
 * uses a Chromium WebView) and WebKit (iOS / iPadOS). BROWSERS=chromium limits it.
 */
export const BROWSER_ENGINES = (process.env.BROWSERS ?? "chromium,webkit")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is "chromium" | "webkit" => s === "chromium" || s === "webkit");

export function launchEngine(engine: "chromium" | "webkit"): Promise<Browser> {
    if (engine === "webkit") return webkit.launch();
    return chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
    });
}

/** tests/browser/entry.ts as one script for a page (obsidian replaced by a stub) */
export async function bundleForBrowser(): Promise<string> {
    const bundle = await build({
        entryPoints: ["tests/browser/entry.ts"],
        bundle: true,
        format: "iife",
        platform: "browser",
        write: false,
        alias: { obsidian: "./tests/browser/obsidian-stub.ts" },
        logLevel: "silent",
    });
    return bundle.outputFiles[0].text;
}
