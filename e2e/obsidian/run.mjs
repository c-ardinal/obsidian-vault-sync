#!/usr/bin/env node
/**
 * Real-app UI check: starts the actual Obsidian desktop app with this plugin
 * installed in a throwaway vault, drives it through the Chrome DevTools
 * Protocol (Playwright connectOverCDP), checks the settings tab and the
 * plugin's other screens (history, transfers, add-on install, exclusion
 * patterns, notices, menus, ribbon) on desktop and phone layouts, and saves
 * screenshots. Modals are checked for a single close control and for content
 * sticking out of the screen.
 *
 *   OBSIDIAN_BIN   path to the unpacked Obsidian executable (see setup-obsidian.mjs)
 *   PLUGIN_DIR     built plugin (default: dist/cardinal-vault-sync)
 *   OUT_DIR        screenshots + report (default: test-results/e2e-obsidian)
 *   E2E_LANGS      comma separated UI languages (default: en,ja)
 *   ADDON_ZIP      optional add-on package (.zip) to show the install review screen
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
const LANGS = (process.env.E2E_LANGS || "en,ja")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, {
        timeout: 60000,
        what: "DevTools endpoint",
    });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await waitFor(
        async () => {
            for (const ctx of browser.contexts()) {
                for (const p of ctx.pages()) {
                    if (
                        await p
                            .evaluate(() => !!window.app?.workspace?.layoutReady)
                            .catch(() => false)
                    ) {
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
                .evaluate(
                    (id) =>
                        !!window.app?.workspace?.layoutReady && !!window.app.plugins.plugins[id],
                    PLUGIN_ID,
                )
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

/**
 * Open the plugin's settings tab. Returns the page that shows it: the main window,
 * or a separate window when this Obsidian version opens settings in one.
 */
async function openSettings(page) {
    await page.evaluate((id) => {
        window.app.setting.open();
        window.app.setting.openTabById(id);
    }, PLUGIN_ID);
    const browser = page.context().browser();
    const found = await waitFor(
        async () => {
            for (const ctx of browser.contexts()) {
                for (const p of ctx.pages()) {
                    if (await p.$(".vault-sync-settings-container").catch(() => null)) return p;
                }
            }
            return null;
        },
        { timeout: 15000, what: "plugin settings tab" },
    ).catch(async (e) => {
        const diag = await page.evaluate(() => {
            const el = window.app.setting.containerEl;
            return {
                activeTab: window.app.setting.activeTab?.id ?? null,
                connected: el?.isConnected ?? null,
                sameDocument: el ? el.ownerDocument === document : null,
                bodyClasses: document.body.className,
            };
        });
        const pages = browser.contexts().flatMap((c) => c.pages().map((p) => p.url()));
        throw new Error(`${e.message}\nsettings diag: ${JSON.stringify({ ...diag, pages })}`);
    });
    return found;
}

async function closeSettings(page) {
    await page.evaluate(() => window.app.setting.close());
    await sleep(300);
}

async function shot(page, lang, label, target, { keepNotices = false } = {}) {
    // Notices (sync status, Obsidian's own hints) float over the UI; drop them for stable images.
    if (!keepNotices)
        await page.evaluate(() =>
            document.querySelectorAll(".notice-container .notice").forEach((n) => n.remove()),
        );
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
    page.$$eval(".vault-sync-settings-nav-item .setting-item-name", (els) =>
        els.map((e) => e.textContent.trim()),
    );

async function settingsText(page) {
    return page.$eval(".vault-sync-settings-container", (el) => el.innerText);
}

async function checkHierarchy(main, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    let page = await openSettings(main);
    if (page !== main) await page.setViewportSize(mobile ? MOBILE : DESKTOP).catch(() => {});
    const target =
        !mobile && (await page.$(".modal.mod-settings")) ? ".modal.mod-settings" : undefined;

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
        check(
            lang,
            `${tag}: page "${names[i]}" opens with matching title`,
            heading === names[i],
            `title="${heading}"`,
        );
        check(lang, `${tag}: page "${names[i]}" has settings`, rows > 0, `${rows} rows`);
        check(
            lang,
            `${tag}: page "${names[i]}" starts at top`,
            scrollTop === 0,
            `scrollTop=${scrollTop}`,
        );
        const text = await settingsText(page);
        if (BANNED_UI_WORDS.test(text)) leaked.push(names[i]);
        await shotSettings(page, lang, `${tag}-page${i + 1}`, target);

        await page.click(".vault-sync-settings-back");
        await page.waitForSelector(".vault-sync-settings-nav-item", {
            timeout: 5000,
        });
        const back = await navNames(page);
        check(
            lang,
            `${tag}: back from "${names[i]}" returns to root`,
            back.join("|") === names.join("|"),
        );
    }
    check(
        lang,
        `${tag}: no add-on internals named in plugin UI`,
        leaked.length === 0,
        leaked.join(", "),
    );

    if (!mobile) {
        // Keyboard: Enter on a focused row opens the page.
        await page.focus(".vault-sync-settings-nav-item");
        await page.keyboard.press("Enter");
        const kbd = await page
            .waitForSelector(".vault-sync-settings-back", { timeout: 3000 })
            .catch(() => null);
        check(lang, `${tag}: Enter on a category opens it`, !!kbd);

        // Closing and reopening settings starts at the category list again.
        await closeSettings(main);
        page = await openSettings(main);
        check(
            lang,
            `${tag}: reopening settings shows the category list`,
            (await page.$$(".vault-sync-settings-nav-item")).length === names.length &&
                (await page.$$(".vault-sync-settings-back")).length === 0,
        );
    }
    await closeSettings(main);
}

// ---------------------------------------------------------------------------
// Non-settings screens: ribbon, notices, modals, menus. Uses the plugin's own
// developer-mode demo commands so no cloud account is needed.
// ---------------------------------------------------------------------------

const cmd = (page, id) =>
    page.evaluate((full) => window.app.commands.executeCommandById(full), `${PLUGIN_ID}:${id}`);

/** Visible close controls in the top-most modal (Obsidian's own + the plugin's). */
async function visibleCloseButtons(page) {
    return page.evaluate(() => {
        const modals = [...document.querySelectorAll(".modal-container .modal")];
        const modal = modals[modals.length - 1];
        if (!modal) return [];
        const out = [];
        for (const el of modal.querySelectorAll(
            // Obsidian's close control (.modal-close-button, or .modal-header-button on 1.15 mobile) and any plugin-made one.
            ".modal-close-button, .modal-header-button, .vault-sync-close-btn, [aria-label='Close']",
        )) {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (
                cs.display === "none" ||
                cs.visibility === "hidden" ||
                r.width === 0 ||
                r.height === 0
            )
                continue;
            out.push({
                cls: el.className,
                x: Math.round(r.x),
                y: Math.round(r.y),
                w: Math.round(r.width),
                h: Math.round(r.height),
            });
        }
        return out;
    });
}

/** Elements of the open modal that stick out of the viewport or overflow sideways. */
async function layoutIssues(page) {
    return page.evaluate(() => {
        const modals = [...document.querySelectorAll(".modal-container .modal")];
        const modal = modals[modals.length - 1];
        if (!modal) return [];
        const vw = window.innerWidth;
        const issues = [];
        const mr = modal.getBoundingClientRect();
        if (mr.right > vw + 1 || mr.left < -1)
            issues.push(`modal ${Math.round(mr.left)}..${Math.round(mr.right)} > ${vw}`);
        for (const el of modal.querySelectorAll("*")) {
            if (
                el.scrollWidth > el.clientWidth + 2 &&
                getComputedStyle(el).overflowX === "visible" &&
                el.clientWidth > 40
            ) {
                const cls = typeof el.className === "string" ? el.className : "";
                // A <select> clips its own long label by design.
                if (cls && !cls.includes("diff") && el.tagName !== "SELECT")
                    issues.push(
                        `overflow-x: ${el.tagName.toLowerCase()}.${cls.split(" ").join(".")}`,
                    );
            }
        }
        return [...new Set(issues)].slice(0, 8);
    });
}

async function modalOpen(page, selector, what) {
    await page.waitForSelector(`.modal-container ${selector}`, { timeout: 8000 });
    await sleep(400);
    return what;
}

/** Shot + generic checks for the top-most modal. */
async function shotModal(page, lang, tag, label, name) {
    const closers = await visibleCloseButtons(page);
    check(
        lang,
        `${tag}: ${name} has exactly one close control`,
        closers.length === 1,
        closers.map((c) => `${c.cls}@${c.x},${c.y}`).join(" ; "),
    );
    const issues = await layoutIssues(page);
    check(lang, `${tag}: ${name} fits the screen`, issues.length === 0, issues.join(" ; "));
    // Phone/tablet: the close button and title must sit below the system status bar
    // (emulated mobile sets --safe-area-inset-top like a real device).
    const top = await page.evaluate(() => {
        const inset =
            parseFloat(getComputedStyle(document.body).getPropertyValue("--safe-area-inset-top")) || 0;
        const modal = [...document.querySelectorAll(".modal-container .modal")].pop();
        const els = [
            ...(modal?.querySelectorAll(".modal-close-button, .modal-header-button, .modal-title") ?? []),
        ].filter((e) => e.getBoundingClientRect().height > 0);
        return { inset, tops: els.map((e) => Math.round(e.getBoundingClientRect().top)) };
    });
    if (top.inset > 0) {
        check(
            lang,
            `${tag}: ${name} header clears the status bar`,
            top.tops.every((y) => y >= top.inset - 1),
            `inset ${top.inset}px, tops ${top.tops.join(",")}`,
        );
    }
    await shot(page, lang, `${tag}-${label}`);
}

async function escape(page) {
    await page.keyboard.press("Escape");
    await sleep(300);
    await closeModals(page);
}

/**
 * Sync status display: status bar + popover (desktop), progress line + pill + sheet
 * (mobile). The real "not signed in" result comes from the manual sync run just
 * before; the other states are driven through the progress tracker directly.
 */
async function checkSyncStatus(page, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    const panelSel = mobile ? ".vault-sync-status-sheet" : ".vault-sync-status-popover";
    const present = await page.evaluate(() => ({
        item: !!document.querySelector(".status-bar .vault-sync-status-item"),
        pill: !!document.querySelector(".vault-sync-status-pill"),
        fab: !!document.querySelector(".vault-sync-mobile-fab"),
    }));
    if (mobile) {
        check(lang, `${tag}: status pill mounted, old indicator gone`, present.pill && !present.fab);
    } else {
        check(lang, `${tag}: status bar item mounted`, present.item);
    }

    const openPanel = async () => {
        await page.evaluate(
            (id) => window.app.plugins.plugins[id].syncStatusView.openDetails(),
            PLUGIN_ID,
        );
        await page.waitForSelector(panelSel, { timeout: 3000 });
        await sleep(450); // bar transitions
    };
    const closePanel = () =>
        page.evaluate(
            (id) => window.app.plugins.plugins[id].syncStatusView.closeDetails(),
            PLUGIN_ID,
        );
    const panelText = () =>
        page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", panelSel);
    const statusText = () =>
        page.evaluate(
            (sel) => document.querySelector(sel)?.textContent ?? "",
            mobile ? ".vault-sync-status-pill" : ".vault-sync-status-item",
        );
    const fits = () =>
        page.evaluate((sel) => {
            const r = document.querySelector(sel)?.getBoundingClientRect();
            if (!r) return false;
            return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        }, panelSel);
    const tracker = (fn, arg) =>
        page.evaluate(
            ({ id, src, arg }) => {
                const p = window.app.plugins.plugins[id];
                // eslint-disable-next-line no-new-func
                return new Function("p", "tr", "arg", src)(p, p.syncManager.progress, arg);
            },
            { id: PLUGIN_ID, src: fn, arg },
        );
    const shotStatus = async (label) => {
        if (mobile) await shot(page, lang, `${tag}-scr-status-${label}`, undefined, { keepNotices: true });
        else await shot(page, lang, `${tag}-scr-status-${label}`, ".status-bar");
    };
    const panelChecks = async (label) => {
        const text = await panelText();
        check(lang, `${tag}: status panel (${label}) has no banned words`, !BANNED_UI_WORDS.test(text), text.slice(0, 120));
        check(lang, `${tag}: status panel (${label}) fits the screen`, await fits());
        const issues = await layoutIssues(page);
        check(lang, `${tag}: status panel (${label}) has no clipped text`, issues.length === 0, issues.join("; "));
    };

    // 1. Real result of the manual sync without an account.
    await sleep(300);
    const authText = await statusText();
    check(lang, `${tag}: status shows "not signed in"`, /Not signed in|未ログイン/.test(authText), authText);
    await shotStatus("auth");
    await openPanel();
    await shot(page, lang, `${tag}-scr-status-panel-auth`);
    await panelChecks("auth");
    await closePanel();
    if (!mobile) {
        // A real click on the status bar item must show the panel on screen (the
        // checks above open it through code, which missed a release-only CSS bug).
        await page.click(".vault-sync-status-item");
        await sleep(300);
        const box = await page.evaluate(() => {
            const el = document.querySelector(".vault-sync-status-popover");
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, h: r.height, vh: innerHeight };
        });
        check(
            lang,
            `${tag}: clicking the status bar item shows the panel on screen`,
            !!box && box.h > 50 && box.top >= 0 && box.bottom <= box.vh,
            JSON.stringify(box),
        );
        await page.click(".vault-sync-status-item");
        await sleep(200);
    }

    // 2. Pretend to be signed in so the other states show as they would. Real sync
    // attempts (auto triggers) would fail with "not signed in" and overwrite the
    // demo states, so they are held off until the end of this check.
    await tracker(`
        p.isAdapterAuthenticated = () => true;
        p.syncManager.requestSmartSync = async () => {};
        p.syncManager.requestBackgroundScan = async () => {};
    `);
    await tracker(`
        tr.begin("manual-sync");
        const pulls = Array.from({ length: 30 }, (_, i) => ({ path: "Notes/Daily/2026-11-" + String(i + 1).padStart(2, "0") + ".md", size: 2400 + i * 37 }));
        pulls.push({ path: "Attachments/Trip to Kyoto/IMG_2048 panorama.jpg", size: 6_800_000 });
        const pushes = Array.from({ length: 17 }, (_, i) => ({ path: "Projects/Plan " + (i + 1) + ".md", size: 1800 }));
        tr.plan("push", pushes);
        tr.plan("pull", pulls);
        tr.phase = "pulling";
        for (const f of pulls.slice(0, 12)) { tr.fileStarted("pull", f.path, f.size); tr.fileFinished("pull", f.path); }
        tr.fileStarted("pull", pulls[30].path, pulls[30].size);
        tr.fileStarted("pull", pulls[12].path, pulls[12].size);
        // Back-date the cycle so the time-left estimate is shown.
        tr.startedAt -= 20000;
        tr.samples = [{ t: Date.now() - 6000, bytes: 0 }, { t: Date.now() - 1000, bytes: tr.pull.bytesDone }];
        tr.pull.bytesDone += 2_400_000;
        tr.emit(true);
    `);
    await sleep(mobile ? 700 : 300);
    const syncingText = await statusText();
    check(lang, `${tag}: status shows the count while syncing`, /12\/48/.test(syncingText), syncingText);
    await shotStatus("syncing");
    await openPanel();
    await shot(page, lang, `${tag}-scr-status-panel-syncing`);
    await panelChecks("syncing");
    await closePanel();

    // 3. Finished.
    await tracker(`
        for (const [dir, m] of Object.entries(tr.planned)) for (const path of m.keys()) tr.fileFinished(dir, path);
        tr.noteConflict();
        tr.finish("ok");
    `);
    await sleep(300);
    const doneText = await statusText();
    check(lang, `${tag}: status shows "synced"`, /Synced|同期済み/.test(doneText), doneText);
    await shotStatus("synced");
    await openPanel();
    await shot(page, lang, `${tag}-scr-status-panel-synced`);
    await panelChecks("synced");
    await closePanel();

    // 4. Failed and offline.
    for (const [outcome, msg] of [
        ["error", "HTTP 500: the server could not complete the request"],
        ["offline", undefined],
    ]) {
        await tracker(
            `tr.begin("timer-sync"); tr.plan("push", [{ path: "a.md", size: 10 }, { path: "b.md", size: 10 }]); tr.fileFinished("push", "a.md"); tr.finish(arg.outcome, arg.msg);`,
            { outcome, msg },
        );
        await sleep(300);
        await shotStatus(outcome);
        await openPanel();
        await shot(page, lang, `${tag}-scr-status-panel-${outcome}`);
        await panelChecks(outcome);
        await closePanel();
    }

    // 5. Full scan.
    await tracker(`tr.begin("full-scan", "scanning"); tr.scanProgress(120, 480);`);
    await sleep(mobile ? 700 : 300);
    await shotStatus("scanning");
    await openPanel();
    await shot(page, lang, `${tag}-scr-status-panel-scanning`);
    await panelChecks("scanning");
    await closePanel();
    await tracker(`
        tr.finish("ok");
        delete p.isAdapterAuthenticated;
        delete p.syncManager.requestSmartSync;
        delete p.syncManager.requestBackgroundScan;
    `);

    // 6. The setting turns it off (and on mobile brings the old indicator back).
    const off = await page.evaluate(async (id) => {
        const p = window.app.plugins.plugins[id];
        p.settings.showSyncStatus = false;
        p.refreshSyncStatusView();
        const r = {
            item: !!document.querySelector(".vault-sync-status-item, .vault-sync-status-pill"),
            fab: !!document.querySelector(".vault-sync-mobile-fab"),
        };
        p.settings.showSyncStatus = true;
        p.refreshSyncStatusView();
        return r;
    }, PLUGIN_ID);
    check(
        lang,
        `${tag}: status display follows the setting`,
        !off.item && off.fab === mobile,
        JSON.stringify(off),
    );
}

/** Transfer status screen: summary, 24h tiles, queue, history filter and batches. */
async function checkTransfers(page, lang, tag) {
    const info = await page.evaluate(() => {
        const m = document.querySelector(".mod-transfer-status-modal");
        return {
            summary: !!m.querySelector(".vault-sync-xfer-summary .vault-sync-status-steps"),
            queue: m.querySelectorAll(".mod-queue .vault-sync-xfer-row").length,
            batches: m.querySelectorAll(".vault-sync-xfer-batch").length,
            open: m.querySelectorAll(".vault-sync-xfer-batch.is-open").length,
        };
    });
    check(
        lang,
        `${tag}: transfer screen shows summary, queue and batched history`,
        info.summary && info.queue >= 3 && info.batches >= 3 && info.open >= 1,
        JSON.stringify(info),
    );
    // Failed filter: only failed rows.
    await page.selectOption("select.vault-sync-xfer-filter", "failed");
    await sleep(300);
    const failedOnly = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".mod-history .vault-sync-xfer-row")];
        return rows.length > 0 && rows.every((r) => r.classList.contains("is-failed"));
    });
    check(lang, `${tag}: transfer history "failed" filter`, failedOnly);
    await shot(page, lang, `${tag}-scr-transfers-failed`);
    await page.selectOption("select.vault-sync-xfer-filter", "all");
    await sleep(300);
    // Open a closed batch, then show the history part.
    await page
        .locator(".vault-sync-xfer-batch:not(.is-open) .vault-sync-xfer-batch-head")
        .first()
        .click();
    await sleep(300);
    const opened = await page.evaluate(
        () => document.querySelectorAll(".vault-sync-xfer-batch.is-open .vault-sync-xfer-row").length,
    );
    check(lang, `${tag}: transfer history batch opens`, opened >= 2, `${opened} rows`);
    await page.evaluate(() => document.querySelector(".mod-history")?.scrollIntoView());
    await sleep(300);
    await shot(page, lang, `${tag}-scr-transfers-history`);
}

/** Display settings: diff text size sliders update the preview. */
async function checkDisplaySettings(main, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    const page = await openSettings(main);
    if (page !== main) await page.setViewportSize(mobile ? MOBILE : DESKTOP).catch(() => {});
    const names = await navNames(page);
    const idx = names.findIndex((n) => /^(Display|表示)$/.test(n));
    check(lang, `${tag}: display settings page listed`, idx >= 0, names.join(" | "));
    if (idx < 0) return;
    const items = await page.$$(".vault-sync-settings-nav-item");
    await items[idx].click();
    await page.waitForSelector(".vault-sync-diff-preview", { timeout: 5000 });
    const sizes = () =>
        page.$$eval(".vault-sync-diff-preview-pane .diff-table", (els) =>
            els.map((e) => getComputedStyle(e).fontSize),
        );
    const setSlider = (value) =>
        page.$eval(
            ".vault-sync-settings-page input.slider",
            (el, v) => {
                el.value = v;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
            },
            value,
        );
    const before = await sizes();
    await setSlider("18"); // desktop slider
    await sleep(400);
    const after = await sizes();
    check(
        lang,
        `${tag}: diff text size slider updates the preview`,
        after[0] === "18px" && after[1] === before[1],
        `${before.join(",")} -> ${after.join(",")}`,
    );
    await page.evaluate(() =>
        document.querySelector(".vault-sync-diff-preview")?.scrollIntoView({ block: "center" }),
    );
    await sleep(300);
    await shot(page, lang, `${tag}-settings-display`);
    await setSlider("14"); // back to the default
    await sleep(300);
    await closeSettings(main);
}

async function checkScreens(page, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    await page.evaluate((id) => {
        const p = window.app.plugins.plugins[id];
        p.settings.isDeveloperMode = true;
        // Avoid real network sync attempts during the run.
        if (p.syncManager) p.syncManager.currentTrigger = "manual-sync";
    }, PLUGIN_ID);

    // Ribbon / mobile sync indicator, idle and syncing.
    await shot(page, lang, `${tag}-scr-workspace`);
    await cmd(page, "dev-demo-sync-animation");
    await sleep(600);
    await shot(page, lang, `${tag}-scr-syncing`);
    await sleep(5000);

    // Notices: the demo sequence plus a sticky conflict notice and the real "not signed in" one.
    await page.evaluate(() =>
        document.querySelectorAll(".notice-container .notice").forEach((n) => n.remove()),
    );
    await cmd(page, "dev-demo-notifications");
    await page.evaluate(async (id) => {
        const sm = window.app.plugins.plugins[id].syncManager;
        setTimeout(
            () =>
                sm.notify("noticeConflictSaved", "Notes/Plan (Conflict 2026-11-19).md", {
                    sticky: true,
                    openPath: "Welcome.md",
                }),
            3200,
        );
    }, PLUGIN_ID);
    await sleep(3800);
    await shot(page, lang, `${tag}-scr-notices`, undefined, {
        keepNotices: true,
    });
    await page.evaluate(() =>
        document.querySelectorAll(".notice-container .notice").forEach((n) => n.remove()),
    );

    // Manual sync without an account (ribbon on desktop, command on mobile).
    await cmd(page, "sync-vault");
    await sleep(1500);
    await shot(page, lang, `${tag}-scr-sync-not-signed-in`, undefined, {
        keepNotices: true,
    });
    await checkSyncStatus(page, lang, { mobile });
    await page.evaluate(() =>
        document.querySelectorAll(".notice-container .notice").forEach((n) => n.remove()),
    );

    // History / diff viewer.
    await cmd(page, "dev-demo-history");
    await modalOpen(page, ".mod-history-modal");
    await page.waitForSelector(".vault-sync-revision-item", { timeout: 8000 }).catch(() => {});
    if (!mobile) {
        await page
            .locator(".vault-sync-revision-item")
            .first()
            .click()
            .catch(() => {});
    }
    await page.waitForSelector(".diff-table", { timeout: 8000 }).catch(() => {});
    await sleep(500);
    await shotModal(page, lang, tag, "scr-history", "history modal");
    if (mobile) {
        await page.click(".vault-sync-history-toggle-btn").catch(() => {});
        await sleep(500);
        await shot(page, lang, `${tag}-scr-history-drawer`);
        await page
            .locator(".vault-sync-revision-item")
            .nth(1)
            .click()
            .catch(() => {});
        await sleep(800);
        await shot(page, lang, `${tag}-scr-history-selected`);
    }
    // Split diff view.
    const splitBtn = page
        .locator(
            ".vault-sync-revision-control-row .clickable-icon, .vault-sync-revision-control-row button",
        )
        .filter({
            has: page.locator("svg.lucide-rows, svg.lucide-rows-2, svg.svg-icon.lucide-rows"),
        });
    if (await splitBtn.count().catch(() => 0)) {
        await splitBtn
            .first()
            .click()
            .catch(() => {});
        await sleep(600);
        await shot(page, lang, `${tag}-scr-history-split`);
    }
    await escape(page);

    // "Restore as" prompt, empty and with an error.
    await cmd(page, "dev-demo-prompt-modal");
    await modalOpen(page, ".vault-sync-prompt-input");
    await shotModal(page, lang, tag, "scr-restore-as", "restore-as dialog");
    await page.fill(".vault-sync-prompt-input", "Notes/existing.md");
    await page.keyboard.press("Enter");
    await sleep(500);
    await shot(page, lang, `${tag}-scr-restore-as-error`);
    await escape(page);

    // Transfer status.
    await cmd(page, "dev-demo-transfer-status");
    await modalOpen(page, ".mod-transfer-status-modal");
    await shotModal(page, lang, tag, "scr-transfers", "transfer status modal");
    await checkTransfers(page, lang, tag);
    await escape(page);

    // Add-on install (and, when a package is given, its terms review).
    await cmd(page, "install-addon");
    await modalOpen(page, ".vault-sync-addon-install");
    await shotModal(page, lang, tag, "scr-addon-install", "add-on install modal");
    if (process.env.ADDON_ZIP) {
        await page
            .setInputFiles(".vault-sync-addon-install input[type=file]", process.env.ADDON_ZIP)
            .catch((e) => check(lang, `${tag}: add-on package picked`, false, String(e)));
        await page.waitForSelector(".vault-sync-addon-terms", { timeout: 10000 }).catch(() => {});
        await sleep(800);
        await shot(page, lang, `${tag}-scr-addon-terms`);
        await page.evaluate(() => {
            const m = document.querySelector(".modal-container .modal");
            const c = m?.querySelector(".modal-content") || m;
            if (c) c.scrollTop = c.scrollHeight;
            if (m) m.scrollTop = m.scrollHeight;
        });
        await sleep(300);
        await shot(page, lang, `${tag}-scr-addon-terms-bottom`);
    }
    await escape(page);

    // Exclusion patterns (opened from the settings, shown here as a dialog).
    const sp = await openSettings(page);
    const scopeName = await sp.$$eval(".vault-sync-settings-nav-item .setting-item-name", (els) =>
        els.map((e) => e.textContent.trim()),
    );
    const items = await sp.$$(".vault-sync-settings-nav-item");
    // Sync scope is the third category.
    if (items[2]) {
        await items[2].click();
        await sp.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const btn = sp
            .locator(".vault-sync-settings-page button")
            .filter({ hasText: /Configure|設定|編集|管理/ })
            .first();
        if (await btn.count()) {
            await btn.click();
            await modalOpen(sp, ".vault-sync-exclusion-modal");
            await shotModal(sp, lang, tag, "scr-exclusion", "exclusion modal");
            await sp.fill(".vault-sync-exclusion-add-input", "Welc");
            await sleep(500);
            await shot(sp, lang, `${tag}-scr-exclusion-typing`);
            await escape(sp);
        } else {
            check(lang, `${tag}: exclusion button found on "${scopeName[2]}"`, false);
        }
    }
    await closeSettings(page);

    // File context menu entry, then the real history modal without an account.
    let menuShown = false;
    if (!mobile) {
        await page.evaluate(() => window.app.workspace.leftSplit?.expand?.());
        const row = page.locator('.nav-file-title[data-path="Welcome.md"]').first();
        if (await row.count()) {
            await row.click({ button: "right" });
            menuShown = !!(await page
                .waitForSelector(".menu", { timeout: 3000 })
                .catch(() => null));
        }
    } else {
        menuShown = await page.evaluate(() => {
            try {
                const { Menu } = window.require("obsidian");
                const file = window.app.vault.getAbstractFileByPath("Welcome.md");
                const menu = new Menu();
                window.app.workspace.trigger("file-menu", menu, file, "file-explorer-context-menu");
                menu.showAtPosition({ x: 100, y: 200 });
                return true;
            } catch {
                return false;
            }
        });
        if (menuShown) await sleep(500);
    }
    if (menuShown) {
        await shot(page, lang, `${tag}-scr-file-menu`);
        const entry = page.locator(".menu .menu-item").filter({ hasText: "Vault-Sync" });
        if (await entry.count()) {
            await entry.first().click();
            await modalOpen(page, ".mod-history-modal").catch(() => {});
            await sleep(2500);
            await shot(page, lang, `${tag}-scr-history-no-account`);
            await escape(page);
        } else {
            await page.keyboard.press("Escape");
        }
    }

    // Command palette filtered to the plugin.
    await page.evaluate(() => window.app.commands.executeCommandById("command-palette:open"));
    const input = await page.waitForSelector(".prompt-input", { timeout: 3000 }).catch(() => null);
    if (input) {
        await input.fill("Vault-Sync");
        await sleep(500);
        await shot(page, lang, `${tag}-scr-commands`);
        await page.keyboard.press("Escape");
        await sleep(300);
    }
    await page.evaluate(
        (id) => (window.app.plugins.plugins[id].settings.isDeveloperMode = false),
        PLUGIN_ID,
    );
}

async function runLang(lang) {
    const root = mkdtempSync(join(tmpdir(), `obsidian-e2e-${lang}-`));
    const { proc, browser, page } = await launch(root);
    page.on("pageerror", (e) =>
        consoleErrors.push({
            lang,
            kind: "pageerror",
            text: `${String(e.stack || e)} (after shot ${shots.at(-1)?.label ?? "-"})`,
        }),
    );
    page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push({ lang, kind: "console", text: m.text() });
    });
    try {
        await page.setViewportSize(DESKTOP);
        await prepare(page, lang);
        const info = await page.evaluate((id) => {
            const m = window.app.plugins.manifests[id];
            return {
                obsidian: window.electron ? undefined : undefined,
                plugin: m?.version,
                lang: window.localStorage.getItem("language") || "en",
            };
        }, PLUGIN_ID);
        const appVersion = await page.evaluate(async () => {
            try {
                return await window.electron.ipcRenderer.sendSync("version");
            } catch {
                return null;
            }
        });
        check(
            lang,
            "plugin loaded in real Obsidian",
            !!info.plugin,
            `plugin ${info.plugin}, Obsidian ${appVersion ?? "?"}, lang ${info.lang}`,
        );
        await shot(page, lang, "desktop-workspace");

        await checkHierarchy(page, lang);
        await checkDisplaySettings(page, lang).catch((e) =>
            check(lang, "desktop: display settings run completed", false, e.stack || String(e)),
        );
        await checkScreens(page, lang).catch(async (e) => {
            check(lang, "desktop: screens run completed", false, e.stack || String(e));
            await shot(page, lang, "desktop-scr-error").catch(() => {});
            await closeModals(page);
        });

        // Mobile layout, emulated by Obsidian itself.
        await page.setViewportSize(MOBILE);
        await page.evaluate(() => window.app.emulateMobile(true)).catch(() => {});
        await sleep(1500);
        await waitReady(page);
        await closeModals(page);
        const isMobile = await page.evaluate(() => window.app.isMobile);
        check(lang, "mobile emulation active", isMobile);
        if (isMobile) {
            await checkHierarchy(page, lang, { mobile: true });
            await checkDisplaySettings(page, lang, { mobile: true }).catch((e) =>
                check(lang, "mobile: display settings run completed", false, e.stack || String(e)),
            );
            await checkScreens(page, lang, { mobile: true }).catch(async (e) => {
                check(lang, "mobile: screens run completed", false, e.stack || String(e));
                await shot(page, lang, "mobile-scr-error").catch(() => {});
            });
        }
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
    writeFileSync(
        join(OUT_DIR, "report.json"),
        JSON.stringify({ results, shots, consoleErrors }, null, 2),
    );
    const lines = [
        `## Obsidian UI check: ${failed.length ? `${failed.length} failed` : "all passed"}`,
        "",
        "| Lang | Check | Result | Detail |",
        "|---|---|---|---|",
        ...results.map(
            (r) =>
                `| ${r.lang} | ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`,
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
    if (!OBSIDIAN_BIN)
        throw new Error("Set OBSIDIAN_BIN (run e2e/obsidian/setup-obsidian.mjs first).");
    rmSync(OUT_DIR, { recursive: true, force: true });
    for (const lang of LANGS) await runLang(lang);
    const pluginErrors = consoleErrors.filter((e) => e.kind === "pageerror");
    check(
        "all",
        "no uncaught page errors",
        pluginErrors.length === 0,
        pluginErrors.map((e) => e.text).join(" / "),
    );
    const failed = writeReport();
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
