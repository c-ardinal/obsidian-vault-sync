/**
 * @file The add-on engine, loaded the way the plugin loads it, in real browser engines
 *
 * The plugin runs the add-on file (CommonJS) by importing it as an ES module from a
 * data: URL after checking its SHA-256 against the approved hash. Node (unit tests)
 * and Electron (Obsidian E2E on CI) accept that, but iPhone and iPad run Obsidian in
 * WebKit, where it was never tried. Here the shipped loader (evaluateEngine) runs the
 * approved engine file in Chromium and WebKit, then the engine does real work.
 *
 * @pass_criteria
 * - the approved engine file passes the hash check, imports, and has every method
 * - a new vault: its lock opens again with the password on a fresh engine instance,
 *   and fails with a wrong one
 * - encrypt / decrypt (single blob and chunked, several chunks) give the bytes back
 * - a changed engine file is refused (null), nothing of it runs
 *
 * The engine file: ADDON_ENGINE_JS, or the build of the engine repository next to this
 * one (../obsidian-vault-syncer-e2ee-engine/dist/e2ee-engine.js). On CI it is required.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import { BROWSER_ENGINES, bundleForBrowser, launchEngine } from "./browsers";

const enginePath = process.env.ADDON_ENGINE_JS || "../obsidian-vault-syncer-e2ee-engine/dist/e2ee-engine.js";
const engineSource = fs.existsSync(enginePath) ? fs.readFileSync(enginePath, "utf8") : null;
if (!engineSource && process.env.CI) throw new Error(`Add-on engine file not found: ${enginePath}`);

let server: http.Server;
let pageUrl = "";

beforeAll(async () => {
    if (!engineSource) return;
    const script = await bundleForBrowser();
    server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" }).end(
            `<!doctype html><meta charset="utf-8"><script>${script.replace(/<\/script/g, "<\\/script")}</script>`,
        );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 60_000);

afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
});

for (const engine of BROWSER_ENGINES) {
    describe.skipIf(!engineSource)(`add-on engine through the plugin's loader in ${engine}`, () => {
        let browser: Browser;
        let page: Page;

        beforeAll(async () => {
            browser = await launchEngine(engine);
            page = await browser.newPage();
            await page.goto(pageUrl);
        }, 60_000);

        afterAll(async () => {
            await browser?.close();
        });

        it("loads the approved engine file and works with it", async () => {
            const r = await page.evaluate(async (source) => {
                const load = (window as any).driveTest.evaluateEngine as (s: string) => Promise<any>;
                const e = await load(source);
                if (!e) return { loaded: false };
                const lock: string = await e.initializeNewVault("correct horse battery staple");
                const plain = new Uint8Array(3 * 1024 * 1024 + 123).map((_, i) => (i * 13) % 256);
                const same = (a: ArrayBuffer) => {
                    const b = new Uint8Array(a);
                    return b.length === plain.length && b.every((x, i) => x === plain[i]);
                };
                const blob = await e.encryptToBlob(plain.buffer);
                const chunked = await e.encryptChunked(plain.buffer);

                // A fresh instance (as after a restart) opens the same lock
                const fresh = await load(source);
                let wrongRejected = false;
                try {
                    await fresh.unlockVault(lock, "wrong password");
                } catch {
                    wrongRejected = true;
                }
                await fresh.unlockVault(lock, "correct horse battery staple");
                return {
                    loaded: true,
                    unlocked: fresh.isUnlocked(),
                    wrongRejected,
                    blob: same(await fresh.decryptFromBlob(blob)),
                    chunkedFormat: fresh.isChunkedFormat(chunked),
                    chunked: same(await fresh.decryptChunked(chunked)),
                };
            }, engineSource!);
            expect(r).toEqual({
                loaded: true,
                unlocked: true,
                wrongRejected: true,
                blob: true,
                chunkedFormat: true,
                chunked: true,
            });
        }, 60_000);

        it("refuses a changed engine file", async () => {
            const r = await page.evaluate(async (source) => {
                (window as any).__ranTampered = false;
                const load = (window as any).driveTest.evaluateEngine as (s: string) => Promise<unknown>;
                const e = await load(source + "\n;window.__ranTampered = true;");
                return { refused: e === null, ran: (window as any).__ranTampered };
            }, engineSource!);
            expect(r).toEqual({ refused: true, ran: false });
        });
    });
}
