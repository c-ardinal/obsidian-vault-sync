#!/usr/bin/env node
/**
 * Real-app UI check: starts the actual Obsidian desktop app with this plugin
 * installed in a throwaway vault, drives it through the Chrome DevTools
 * Protocol (Playwright connectOverCDP), checks the settings tab and saves
 * screenshots.
 *
 *   OBSIDIAN_BIN   path to the unpacked Obsidian executable (see setup-obsidian.mjs)
 *   PLUGIN_DIR     built plugin (default: dist/cardinal-vault-sync)
 *   OUT_DIR        screenshots + report (default: test-results/e2e-obsidian)
 *   E2E_LANGS      comma separated UI languages (default: en,ja)
 *
 * Needs a display; in CI it runs under xvfb-run. Exit code 1 on any failed check.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const PLUGIN_DIR = resolve(process.env.PLUGIN_DIR || "dist/cardinal-vault-sync");
const OUT_DIR = resolve(process.env.OUT_DIR || "test-results/e2e-obsidian");
const LANGS = (process.env.E2E_LANGS || "en,ja").split(",").map((s) => s.trim()).filter(Boolean);
const OBSIDIAN_BIN = process.env.OBSIDIAN_BIN;
const PLUGIN_ID = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8")).id;

const DESKTOP = { width: 1280, height: 860 };
const MOBILE = { width: 412, height: 915 };
/** The plugin's own UI must stay neutral about what add-ons do. */
const BANNED_UI_WORDS = /e2ee|encrypt|暗号|復号/i;

const results = []; // { lang, name, ok, detail }
const shots = []; // { lang, file, label }
const consoleErrors = [];

function check(lang, name, ok, detail = "") {
    results.push({ lang, name, ok: !!ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} [${lang}] ${name}${detail ? ` - ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 250, what = "condition" } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            const v = await fn();
            if (v) return v;
        } catch (e) {
            last = e;
        }
        await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

function freePort() {
    return new Promise((res, rej) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => res(port));
        });
        srv.on("error", rej);
    });
}

function makeVault(root) {
    const vault = join(root, "vault");
    const pluginDest = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    mkdirSync(pluginDest, { recursive: true });
    for (const f of ["main.js", "manifest.json", "styles.css"]) {
        copyFileSync(join(PLUGIN_DIR, f), join(pluginDest, f));
    }
    writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([PLUGIN_ID]));
    writeFileSync(join(vault, "Welcome.md"), "# E2E vault\n");

    const configDir = join(root, "config", "obsidian");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
        join(configDir, "obsidian.json"),
        JSON.stringify({
            vaults: { e2e0000000000001: { path: vault, ts: Date.now(), open: true } },
            updateDisabled: true,
        }),
    );
    return { vault, xdgConfig: join(root, "config") };
}

async function launch(root) {
    const { xdgConfig } = makeVault(root);
    const port = await freePort();
    const proc = spawn(
        OBSIDIAN_BIN,
        ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`],
        {
            env: { ...process.env, XDG_CONFIG_HOME: xdgConfig },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let log = "";
    proc.stdout.on("data", (d) => (log += d));
    proc.stderr.on("data", (d) => (log += d));
    proc.on("exit", (code) => {
        if (code) console.error(`Obsidian exited with ${code}\n${log.slice(-4000)}`);
    });

    await waitFor(
        async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
        { timeout: 60000, what: "DevTools endpoint" },
    );
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await waitFor(
        async () => {
            for (const ctx of browser.contexts()) {
                for (const p of ctx.pages()) {
                    if (await p.evaluate(() => !!window.app?.workspace?.layoutReady).catch(() => false)) {
                        return p;
                    }
                }
            }
            return null;
        },
        { timeout: 90000, what: "vault window" },
    );
    return { proc, browser, page };
}

async function waitReady(page) {
    await waitFor(
        () =>
            page
                .evaluate((id) => !!window.app?.workspace?.layoutReady && !!window.app.plugins.plugins[id], PLUGIN_ID)
                .catch(() => false),
        { timeout: 60000, what: "workspace + plugin loaded" },
    );
}

/** Turn community plugins on (skips the restricted-mode prompt) and set the UI language, then reload. */
async function prepare(page, lang) {
    await page.evaluate(
        async ({ id, lang }) => {
            const p = window.app.plugins;
            if (!p.isEnabled()) await p.setEnable(true);
            if (!p.enabledPlugins.has(id)) await p.enablePluginAndSave(id);
            if (lang === "en") window.localStorage.removeItem("language");
            else window.localStorage.setItem("language", lang);
        },
        { id: PLUGIN_ID, lang },
    );
    await page.evaluate(() => window.location.reload()).catch(() => {});
    await sleep(1000);
    await waitReady(page);
    await closeModals(page);
}

async function closeModals(page) {
    await page.evaluate(() => {
        document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click());
    });
    await sleep(300);
}

async function openSettings(page) {
    await page.evaluate(() => window.app.setting.open());
    await page.waitForSelector(".modal.mod-settings", { timeout: 10000 }).catch(() => {});
    await page.evaluate((id) => window.app.setting.openTabById(id), PLUGIN_ID);
    try {
        await page.waitForSelector(".vault-sync-settings-container", { timeout: 15000 });
    } catch (e) {
        const diag = await page.evaluate((id) => {
            const s = window.app.setting;
            return {
                modals: [...document.querySelectorAll(".modal")].map((m) => m.className),
                activeTab: s.activeTab?.id ?? null,
                pluginTabs: (s.pluginTabs || []).map((t) => t.id),
                hasPlugin: !!window.app.plugins.plugins[id],
            };
        }, PLUGIN_ID);
        throw new Error(`${e.message}\nsettings diag: ${JSON.stringify(diag)}`);
    }
}

async function closeSettings(page) {
    await page.evaluate(() => window.app.setting.close());
    await sleep(300);
}

async function shot(page, lang, label, target) {
    const dir = join(OUT_DIR, lang);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${String(shots.length).padStart(2, "0")}-${label}.png`);
    if (target) await page.locator(target).first().screenshot({ path: file });
    else await page.screenshot({ path: file });
    shots.push({ lang, file, label });
}

/** Screenshot the settings modal; when the page scrolls, also its bottom part. */
async function shotSettings(page, lang, label, target = ".modal.mod-settings") {
    await shot(page, lang, label, target);
    const overflow = await page.evaluate(() => {
        const el = document.querySelector(".vault-sync-settings-container");
        return el ? el.scrollHeight - el.clientHeight : 0;
    });
    if (overflow > 40) {
        await page.evaluate(() => {
            const el = document.querySelector(".vault-sync-settings-container");
            el.scrollTop = el.scrollHeight;
        });
        await sleep(200);
        await shot(page, lang, `${label}-bottom`, target);
        await page.evaluate(() => {
            document.querySelector(".vault-sync-settings-container").scrollTop = 0;
        });
    }
}

const navNames = (page) =>
    page.$$eval(".vault-sync-settings-nav-item .setting-item-name", (els) => els.map((e) => e.textContent.trim()));

async function settingsText(page) {
    return page.$eval(".vault-sync-settings-container", (el) => el.innerText);
}

async function checkHierarchy(page, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    const target = mobile ? undefined : ".modal.mod-settings";
    await openSettings(page);

    const names = await navNames(page);
    check(lang, `${tag}: root lists categories`, names.length >= 5, names.join(" | "));
    check(
        lang,
        `${tag}: root has no back button`,
        (await page.$$(".vault-sync-settings-back")).length === 0,
    );
    await shotSettings(page, lang, `${tag}-root`, target);

    const leaked = [];
    for (let i = 0; i < names.length; i++) {
        const items = await page.$$(".vault-sync-settings-nav-item");
        await items[i].click();
        await page.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const heading = await page.$eval(
            ".vault-sync-settings-container .setting-item-heading .setting-item-name",
            (el) => el.textContent.trim(),
        );
        const rows = (await page.$$(".vault-sync-settings-page .setting-item")).length;
        const scrollTop = await page.$eval(".vault-sync-settings-container", (el) => el.scrollTop);
        check(lang, `${tag}: page "${names[i]}" opens with matching title`, heading === names[i], `title="${heading}"`);
        check(lang, `${tag}: page "${names[i]}" has settings`, rows > 0, `${rows} rows`);
        check(lang, `${tag}: page "${names[i]}" starts at top`, scrollTop === 0, `scrollTop=${scrollTop}`);
        const text = await settingsText(page);
        if (BANNED_UI_WORDS.test(text)) leaked.push(names[i]);
        await shotSettings(page, lang, `${tag}-page${i + 1}`, target);

        await page.click(".vault-sync-settings-back");
        await page.waitForSelector(".vault-sync-settings-nav-item", { timeout: 5000 });
        const back = await navNames(page);
        check(lang, `${tag}: back from "${names[i]}" returns to root`, back.join("|") === names.join("|"));
    }
    check(lang, `${tag}: no add-on internals named in plugin UI`, leaked.length === 0, leaked.join(", "));

    if (!mobile) {
        // Keyboard: Enter on a focused row opens the page.
        await page.focus(".vault-sync-settings-nav-item");
        await page.keyboard.press("Enter");
        const kbd = await page.waitForSelector(".vault-sync-settings-back", { timeout: 3000 }).catch(() => null);
        check(lang, `${tag}: Enter on a category opens it`, !!kbd);

        // Closing and reopening settings starts at the category list again.
        await closeSettings(page);
        await openSettings(page);
        check(
            lang,
            `${tag}: reopening settings shows the category list`,
            (await page.$$(".vault-sync-settings-nav-item")).length === names.length &&
                (await page.$$(".vault-sync-settings-back")).length === 0,
        );
    }
    await closeSettings(page);
}

async function runLang(lang) {
    const root = mkdtempSync(join(tmpdir(), `obsidian-e2e-${lang}-`));
    const { proc, browser, page } = await launch(root);
    page.on("pageerror", (e) => consoleErrors.push({ lang, kind: "pageerror", text: String(e) }));
    page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push({ lang, kind: "console", text: m.text() });
    });
    try {
        await page.setViewportSize(DESKTOP);
        await prepare(page, lang);
        const info = await page.evaluate((id) => {
            const m = window.app.plugins.manifests[id];
            return { obsidian: window.electron ? undefined : undefined, plugin: m?.version, lang: window.localStorage.getItem("language") || "en" };
        }, PLUGIN_ID);
        const appVersion = await page.evaluate(async () => {
            try {
                return await window.electron.ipcRenderer.sendSync("version");
            } catch {
                return null;
            }
        });
        check(lang, "plugin loaded in real Obsidian", !!info.plugin, `plugin ${info.plugin}, Obsidian ${appVersion ?? "?"}, lang ${info.lang}`);
        await shot(page, lang, "desktop-workspace");

        await checkHierarchy(page, lang);

        // Mobile layout, emulated by Obsidian itself.
        await page.setViewportSize(MOBILE);
        await page.evaluate(() => window.app.emulateMobile(true)).catch(() => {});
        await sleep(1500);
        await waitReady(page);
        await closeModals(page);
        const isMobile = await page.evaluate(() => window.app.isMobile);
        check(lang, "mobile emulation active", isMobile);
        if (isMobile) await checkHierarchy(page, lang, { mobile: true });
    } catch (e) {
        check(lang, "run completed", false, e.stack || String(e));
        await shot(page, lang, "error").catch(() => {});
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
        await sleep(500);
        if (!proc.killed) proc.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
    }
}

function writeReport() {
    mkdirSync(OUT_DIR, { recursive: true });
    const failed = results.filter((r) => !r.ok);
    writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify({ results, shots, consoleErrors }, null, 2));
    const lines = [
        `## Obsidian UI check: ${failed.length ? `${failed.length} failed` : "all passed"}`,
        "",
        "| Lang | Check | Result | Detail |",
        "|---|---|---|---|",
        ...results.map(
            (r) => `| ${r.lang} | ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`,
        ),
        "",
        `${shots.length} screenshots in the \`e2e-obsidian-screenshots\` artifact.`,
    ];
    if (consoleErrors.length) {
        lines.push("", "<details><summary>Console errors</summary>", "", "```");
        for (const e of consoleErrors) lines.push(`[${e.lang}] ${e.kind}: ${e.text.slice(0, 500)}`);
        lines.push("```", "</details>");
    }
    writeFileSync(join(OUT_DIR, "summary.md"), lines.join("\n") + "\n");
    return failed.length;
}

async function main() {
    if (!OBSIDIAN_BIN) throw new Error("Set OBSIDIAN_BIN (run e2e/obsidian/setup-obsidian.mjs first).");
    rmSync(OUT_DIR, { recursive: true, force: true });
    for (const lang of LANGS) await runLang(lang);
    const pluginErrors = consoleErrors.filter((e) => e.kind === "pageerror");
    check("all", "no uncaught page errors", pluginErrors.length === 0, pluginErrors.map((e) => e.text).join(" / "));
    const failed = writeReport();
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
