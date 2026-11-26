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
 *   ADDON_ZIP      optional add-on package (.zip): shows the install review screen, then
 *                  installs it and checks the add-on's own settings page and commands
 *   E2E_SYNC       "0" skips the real sync check (sync against a Drive-like local
 *                  server: edits, folder renames both ways, deletes); "only" runs just it
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
const BANNED_UI_WORDS = /e2ee|encrypt|暗号|復号|加密|解密|암호화|복호화/i;

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

    // Search on the top page: matching settings with their controls, page list hidden
    const searchInput = ".vault-sync-settings-search input";
    await page.fill(searchInput, lang === "ja" ? "削除" : "trash");
    await sleep(300);
    const hits = (await page.$$(".vault-sync-settings-search-results .setting-item")).length;
    const navHidden = await page.$eval(".vault-sync-settings-nav", (el) => el.offsetParent === null);
    check(lang, `${tag}: settings search shows matches`, hits > 0 && navHidden, `${hits} hits, nav hidden=${navHidden}`);
    check(lang, `${tag}: settings search results name no add-on internals`, !BANNED_UI_WORDS.test(await settingsText(page)));
    await shotSettings(page, lang, `${tag}-search`, target);
    await page.fill(searchInput, "zzqx-no-such-setting");
    await sleep(300);
    check(
        lang,
        `${tag}: settings search says when nothing matches`,
        (await page.$$(".vault-sync-settings-search-none")).length === 1,
    );
    await page.fill(searchInput, "");
    await sleep(300);
    check(
        lang,
        `${tag}: clearing the search shows the category list again`,
        (await navNames(page)).join("|") === names.join("|") &&
            (await page.$$(".vault-sync-settings-search-results .setting-item")).length === 0,
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
    // The no-account sync ends fast, but a slow CI machine can still show "Syncing"
    // after a fixed pause: wait (bounded) for it to settle instead.
    let authText = "";
    for (let i = 0; i < 20; i++) {
        await sleep(i === 0 ? 300 : 250);
        authText = await statusText();
        if (/Not signed in|未ログイン|未登录|로그인 안 됨/.test(authText)) break;
    }
    check(lang, `${tag}: status shows "not signed in"`, /Not signed in|未ログイン|未登录|로그인 안 됨/.test(authText), authText);
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
    check(lang, `${tag}: status shows "synced"`, /Synced|同期済み|已同步|동기화됨/.test(doneText), doneText);
    await shotStatus("synced");
    await openPanel();
    await shot(page, lang, `${tag}-scr-status-panel-synced`);
    await panelChecks("synced");
    // The conflict count opens the resolver; "more" lists the plugin's other screens.
    const panelParts = await page.evaluate(
        (sel) => ({
            conflictLink: !!document.querySelector(`${sel} a.vault-sync-status-link`),
            more: !!document.querySelector(`${sel} .vault-sync-status-more`),
        }),
        panelSel,
    );
    check(lang, `${tag}: status panel conflict count is a link`, panelParts.conflictLink);
    check(lang, `${tag}: status panel has a "more" button`, panelParts.more);
    if (panelParts.more) {
        await page.click(`${panelSel} .vault-sync-status-more`);
        await page.waitForSelector(".menu", { timeout: 3000 }).catch(() => {});
        const menuItems = await page.$$eval(".menu .menu-item-title", (els) => els.map((e) => e.textContent.trim()));
        check(lang, `${tag}: "more" menu lists the screens`, menuItems.length >= 6, menuItems.join(" | "));
        await shot(page, lang, `${tag}-scr-status-more-menu`);
        await page.keyboard.press("Escape");
        await sleep(200);
        if (!(await page.$(panelSel))) await openPanel();
    }
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
    const idx = names.findIndex((n) => /^(Display|表示|显示|표시)$/.test(n));
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

/**
 * Settings and screens added for the sync proposals: per-PC/mobile .obsidian
 * categories and file-size limit on the sync scope page, and the mass
 * delete/overwrite question.
 */
async function checkScopeAndMassChange(main, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    await main.evaluate((id) => {
        const p = window.app.plugins.plugins[id];
        p.settings.obsidianScopeStrategy = "per-platform";
        p.settings.desktopMaxFileSizeMB = 100;
        p.settings.mobileMaxFileSizeMB = 20;
    }, PLUGIN_ID);
    const page = await openSettings(main);
    if (page !== main) await page.setViewportSize(mobile ? MOBILE : DESKTOP).catch(() => {});
    const names = await navNames(page);
    const idx = names.findIndex((n) => /^(Sync [Ss]cope|同期範囲|同步范围|동기화 범위)$/.test(n));
    check(lang, `${tag}: sync scope page listed`, idx >= 0, names.join(" | "));
    if (idx >= 0) {
        await (await page.$$(".vault-sync-settings-nav-item"))[idx].click();
        await page.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const text = await settingsText(page);
        const suffix = mobile ? /(mobile|モバイル|移动端|모바일)/ : /\(PC\)|（PC）/;
        check(lang, `${tag}: own-platform .obsidian toggles shown`, suffix.test(text));
        const scrollTo = (re) =>
            page.evaluate((src) => {
                const r = new RegExp(src);
                [...document.querySelectorAll(".vault-sync-settings-page .setting-item")]
                    .find((e) => r.test(e.querySelector(".setting-item-name")?.textContent ?? ""))
                    ?.scrollIntoView({ block: "start" });
            }, re);
        await scrollTo("Obsidian");
        await sleep(300);
        await shot(page, lang, `${tag}-settings-scope-per-platform`);
        await scrollTo("(File size limit|ファイルサイズ上限|文件大小上限|파일 크기 제한)");
        await sleep(300);
        await shot(page, lang, `${tag}-settings-size-limit`);
    }
    await closeSettings(main);

    // The question one sync asks before deleting / overwriting many files
    await main.evaluate((id) => {
        const p = window.app.plugins.plugins[id];
        const changes = [];
        for (let i = 1; i <= 3; i++) changes.push({ action: "delete-remote", path: `Archive/old-${i}.md`, kind: "file" });
        for (let i = 1; i <= 24; i++) changes.push({ action: "overwrite-remote", path: `Notes/note-${i}.md`, kind: "file" });
        void p.syncManager.planGuard.review({ step: "push", changes });
    }, PLUGIN_ID);
    await modalOpen(main, ".vault-sync-mass-delete-list", "mass change");
    await shotModal(main, lang, tag, "scr-mass-overwrite", "mass overwrite question");
    await escape(main);
    await main.evaluate((id) => {
        const p = window.app.plugins.plugins[id];
        p.settings.obsidianScopeStrategy = "unified";
        p.settings.desktopMaxFileSizeMB = -1;
        p.settings.mobileMaxFileSizeMB = -1;
    }, PLUGIN_ID);
}

/**
 * Data protection page (restore tools first) and the number fields: a value out
 * of range is moved to the nearest limit when the field is committed.
 */
async function checkProtectionAndNumbers(main, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    const page = await openSettings(main);
    if (page !== main) await page.setViewportSize(mobile ? MOBILE : DESKTOP).catch(() => {});
    let names = await navNames(page);
    check(
        lang,
        `${tag}: root no longer has a mixed "performance" page`,
        !names.some((n) => /^(Performance|パフォーマンス)$/.test(n)),
        names.join(" | "),
    );
    const prot = names.findIndex((n) =>
        /^(Data protection and restore|データ保護・復元|数据保护与恢复|데이터 보호·복원)$/.test(n),
    );
    check(lang, `${tag}: data protection page listed`, prot >= 0, names.join(" | "));
    if (prot >= 0) {
        await (await page.$$(".vault-sync-settings-nav-item"))[prot].click();
        await page.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const firstRows = await page.$$eval(".vault-sync-settings-page .setting-item:not(.setting-item-heading)", (els) =>
            els.slice(0, 3).map((e) => !!e.querySelector("button")),
        );
        check(
            lang,
            `${tag}: restore tools come first`,
            firstRows.length === 3 && firstRows.every(Boolean),
            JSON.stringify(firstRows),
        );
        await shot(page, lang, `${tag}-settings-protection`);
        await page.click(".vault-sync-settings-back");
        await sleep(300);
    }
    names = await navNames(page);
    const tr = names.findIndex((n) => /^(Transfers|転送|传输|전송)$/.test(n));
    check(lang, `${tag}: transfer page listed`, tr >= 0, names.join(" | "));
    if (tr >= 0) {
        await (await page.$$(".vault-sync-settings-nav-item"))[tr].click();
        await page.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const input = page.locator(".vault-sync-settings-page .vault-sync-number-setting input").first();
        await input.fill("50");
        await input.press("Enter");
        await sleep(300);
        // The settings may be their own window: read the field there, the value in the app
        const r = await page.evaluate(() => {
            const el = document.querySelector(".vault-sync-settings-page .vault-sync-number-setting input");
            const hint = document.querySelector(".vault-sync-settings-page .vault-sync-number-hint");
            return { shown: el?.value, flagged: hint?.classList.contains("is-error") };
        });
        r.saved = await main.evaluate((id) => window.app.plugins.plugins[id].settings.concurrency, PLUGIN_ID);
        check(
            lang,
            `${tag}: out-of-range number is clamped, shown and flagged`,
            r.saved === 10 && r.shown === "10" && r.flagged,
            JSON.stringify(r),
        );
        await shot(page, lang, `${tag}-settings-number-clamped`);
        const resetShown = await page.evaluate(() => {
            const b = document.querySelector(".vault-sync-settings-page .vault-sync-number-setting .vault-sync-reset-default");
            return !!b && b.style.display !== "none";
        });
        check(lang, `${tag}: changed number offers "restore default"`, resetShown);
        await page.click(".vault-sync-settings-page .vault-sync-number-setting .vault-sync-reset-default");
        await sleep(300);
        const afterReset = await main.evaluate((id) => window.app.plugins.plugins[id].settings.concurrency, PLUGIN_ID);
        check(lang, `${tag}: "restore default" sets the default`, afterReset === 5, String(afterReset));
        await page.click(".vault-sync-settings-back");
        await sleep(300);
    }
    // Triggers page: Obsidian headings (no uppercase), folded details, no "Trigger:" prefix
    names = await navNames(page);
    const trg = names.findIndex((n) => /^(Sync triggers|同期トリガー|同步触发|동기화 트리거)/.test(n));
    check(lang, `${tag}: triggers page listed`, trg >= 0, names.join(" | "));
    if (trg >= 0) {
        await (await page.$$(".vault-sync-settings-nav-item"))[trg].click();
        await page.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const t = await page.evaluate(() => {
            const pageEl = document.querySelector(".vault-sync-settings-page");
            const heads = [...pageEl.querySelectorAll(".vault-sync-subheader-group > .setting-item-heading")];
            const names = [...pageEl.querySelectorAll(".setting-item:not(.setting-item-heading) .setting-item-name")].map(
                (e) => e.textContent.trim(),
            );
            return {
                heads: heads.length,
                upper: heads.some((h) => getComputedStyle(h.querySelector(".setting-item-name")).textTransform === "uppercase"),
                details: pageEl.querySelectorAll("details.vault-sync-setting-detail").length,
                prefixed: names.filter((n) => /^(Trigger:|トリガー:)/.test(n)),
                hint: pageEl.querySelector(".vault-sync-number-hint")?.textContent ?? "",
            };
        });
        check(
            lang,
            `${tag}: triggers page uses plain headings, folded details, no prefix`,
            t.heads >= 2 && !t.upper && t.details >= 1 && t.prefixed.length === 0,
            JSON.stringify(t),
        );
        check(lang, `${tag}: number range reads "default first"`, /^(Default|既定) /.test(t.hint), t.hint);
        await page.evaluate(() => {
            const d = document.querySelector(".vault-sync-settings-page details.vault-sync-setting-detail");
            if (d) d.open = true;
        });
        await shot(page, lang, `${tag}-settings-triggers`);
        await page.click(".vault-sync-settings-back");
        await sleep(300);
    }
    // Obsidian's own settings search lists Vault Syncer rows (Obsidian 1.13+)
    const defs = await main.evaluate((id) => {
        const tab = window.app.setting.pluginTabs.find((x) => x.id === id);
        return tab?.settingItems?.length ?? -1;
    }, PLUGIN_ID);
    check(lang, `${tag}: settings are offered to Obsidian's own search`, defs > 10, String(defs));
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

    // Conflict resolve screen: a note and its conflict copy, resolved by hand.
    await page.evaluate(async () => {
        const v = window.app.vault;
        const note = "E2E/Plan.md";
        const copy = "E2E/Plan (Conflict 2026-11-20T08-00-00).md";
        if (!v.getAbstractFileByPath("E2E")) await v.createFolder("E2E");
        for (const p of [note, copy]) {
            const f = v.getAbstractFileByPath(p);
            if (f) await v.delete(f);
        }
        const shared = Array.from({ length: 12 }, (_, i) => `- shared item ${i + 1}`).join("\n");
        await v.create(note, `# Plan\n\nGoal: ship on Friday\n\n${shared}\n\nOwner: cloud side\n`);
        await v.create(copy, `# Plan\n\nGoal: ship on Thursday after review\n\n${shared}\n\nOwner: this device\nNotes: added here\n`);
    });
    await cmd(page, "resolve-conflicts");
    await modalOpen(page, ".vault-sync-conflict-chunks");
    await shotModal(page, lang, tag, "scr-conflict-resolve", "conflict resolve modal");
    await page.locator(".vault-sync-conflict-choices button").nth(2).click();
    await sleep(300);
    const merged = await page.$eval(".vault-sync-conflict-result", (el) => el.value);
    check(
        lang,
        `${tag}: conflict result takes both sides`,
        merged.includes("ship on Thursday") && merged.includes("ship on Friday"),
        merged.slice(0, 120),
    );
    await shot(page, lang, `${tag}-scr-conflict-resolve-both`);
    await page.locator(".vault-sync-conflict-buttons button.mod-cta").click();
    await sleep(800);
    const after = await page.evaluate(async () => {
        const v = window.app.vault;
        const f = v.getAbstractFileByPath("E2E/Plan.md");
        return {
            text: f ? await v.read(f) : null,
            copyLeft: !!v.getAbstractFileByPath("E2E/Plan (Conflict 2026-11-20T08-00-00).md"),
        };
    });
    check(
        lang,
        `${tag}: conflict saved and copy removed`,
        !!after.text?.includes("ship on Thursday") && !after.copyLeft,
        JSON.stringify(after).slice(0, 200),
    );
    await closeModals(page);

    // Devices and changes, with sample records (no cloud account in this run).
    await page.evaluate((id) => {
        const sm = window.app.plugins.plugins[id].syncManager;
        const now = Date.now();
        const min = 60 * 1000;
        const self = sm.thisDeviceId || "self0001";
        const records = [
            {
                formatVersion: 1, id: self, name: "Linux (self)", platform: "Linux", lastSyncAt: now - 2 * min,
                activity: [
                    { t: now - 3 * min, op: "edit", path: "Welcome.md" },
                    { t: now - 50 * min, op: "create", path: "Projects/Plan.md" },
                ],
            },
            {
                formatVersion: 1, id: "phone001", name: "iPhone", platform: "iPhone", lastSyncAt: now - 30 * min,
                activity: [
                    { t: now - 31 * min, op: "rename", path: "Journal/2026-11-20.md", from: "Untitled.md" },
                    { t: now - 40 * min, op: "conflict", path: "Projects/Plan.md" },
                    { t: now - 90 * min, op: "delete", path: "Old/Draft with a long name that wraps on a phone screen.md" },
                ],
            },
        ];
        sm.listDevices = async () => records;
        sm.forgetDevice = async () => {};
    }, PLUGIN_ID);
    await cmd(page, "show-devices");
    await modalOpen(page, ".vault-sync-activity-list");
    await shotModal(page, lang, tag, "scr-devices", "devices modal");
    const rows = await page.$$eval(".vault-sync-activity-row", (els) => els.length);
    check(lang, `${tag}: devices modal lists all changes`, rows === 5, `rows=${rows}`);
    // Every note paragraph shows all its lines (none is squeezed by the modal layout)
    const clipped = await page.$$eval(".vault-sync-devices-note", (els) =>
        els.filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent.slice(0, 30)),
    );
    check(lang, `${tag}: devices modal texts are not cut`, clipped.length === 0, clipped.join(" / "));
    await escape(page);

    // Diagnostic info: the text is built, and nothing private or add-on specific shows
    await cmd(page, "copy-diagnostics");
    await modalOpen(page, ".vault-sync-diagnostics-text");
    await page
        .waitForFunction(() => document.querySelector(".vault-sync-diagnostics-text")?.value.includes("### Settings"), null, { timeout: 5000 })
        .catch(() => {});
    await shotModal(page, lang, tag, "scr-diagnostics", "diagnostics modal");
    const diag = await page.$eval(".vault-sync-diagnostics-text", (e) => e.value);
    check(lang, `${tag}: diagnostics text is built`, diag.includes("## Vault Syncer diagnostics") && diag.includes("### Settings"), diag.slice(0, 80));
    check(lang, `${tag}: diagnostics hide private settings`, !/encryptionSecret|e2ee|clientSecret|token/i.test(diag.split("### Log")[0]), "");
    const diagClipped = await page.$$eval(".vault-sync-diagnostics-note, .vault-sync-diagnostics-modal .setting-item-description", (els) =>
        els.filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent.slice(0, 30)),
    );
    check(lang, `${tag}: diagnostics texts are not cut`, diagClipped.length === 0, diagClipped.join(" / "));
    // "Report on GitHub": the new-issue page with the text filled in (the browser is not opened here)
    await page.evaluate(() => {
        window.__openedUrl = null;
        window.__realOpen = window.open;
        window.open = (u) => {
            window.__openedUrl = String(u);
            return null;
        };
    });
    await page.click(".vault-sync-diagnostics-modal .modal-button-container .mod-cta");
    await sleep(300);
    const opened = await page.evaluate(() => {
        const u = window.__openedUrl;
        window.open = window.__realOpen;
        return u;
    });
    const openedBody = opened ? decodeURIComponent(new URL(opened).searchParams.get("body") || "") : "";
    check(
        lang,
        `${tag}: report opens the new-issue page with the diagnostics`,
        !!opened && opened.startsWith("https://github.com/c-ardinal/obsidian-vault-sync/issues/new?") && openedBody.includes("## Vault Syncer diagnostics") && opened.length <= 7500,
        opened ? `length=${opened.length}` : "not opened",
    );
    await escape(page);

    // Restore to a past time: the form, the plan (stubbed: no cloud here), then apply
    await page.evaluate((id) => {
        const sm = window.app.plugins.plugins[id].syncManager;
        const now = Date.now();
        sm.planPointInTimeRestore = async (folder, time, opts) => {
            opts?.onProgress?.(3, 5);
            return {
                time,
                folder: folder.trim(),
                entries: [
                    { path: "Notes/Plan.md", action: "restore", revision: { id: "r1", modifiedTime: now - 864e5, size: 10 } },
                    { path: "Notes/Gone.md", action: "recreate", trashed: { id: "t1", originalPath: "Notes/Gone.md", day: "2026-11-19", size: 1, mtime: 0 } },
                    { path: "Notes/New idea with a long name that wraps on a phone.md", action: "created-after" },
                    { path: "Notes/Same.md", action: "unchanged" },
                ],
            };
        };
        window.__pitApplied = null;
        sm.applyPointInTimeRestore = async (plan, opts) => {
            window.__pitApplied = opts.removeCreatedAfter;
            return { restored: 1, recreated: 1, removed: 0, failed: [] };
        };
    }, PLUGIN_ID);
    await cmd(page, "restore-to-point-in-time");
    await modalOpen(page, ".vault-sync-pit-folder");
    await shotModal(page, lang, tag, "scr-pit-form", "point-in-time form");
    await page.fill(".vault-sync-pit-folder", "Notes");
    await page.click(".vault-sync-pit-modal .modal-button-container .mod-cta");
    await page.waitForSelector(".vault-sync-pit-summary", { timeout: 5000 }).catch(() => {});
    await shotModal(page, lang, tag, "scr-pit-plan", "point-in-time plan");
    const pitRows = (await page.$$(".vault-sync-pit-row")).length;
    check(lang, `${tag}: restore plan lists the files to change`, pitRows === 3, `rows=${pitRows}`);
    const pitClipped = await page.$$eval(".vault-sync-pit-note, .vault-sync-pit-modal .setting-item-description", (els) =>
        els.filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent.slice(0, 30)),
    );
    check(lang, `${tag}: restore texts are not cut`, pitClipped.length === 0, pitClipped.join(" / "));
    await page.click(".vault-sync-pit-modal .modal-button-container .mod-cta");
    await sleep(400);
    const pitApplied = await page.evaluate(() => window.__pitApplied);
    check(lang, `${tag}: restore runs, keeping files created after`, pitApplied === false, String(pitApplied));
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
            .filter({ hasText: /Configure|Edit|設定|編集|管理|配置|编辑|설정|편집/ })
            .first();
        if (await btn.count()) {
            await btn.click();
            await modalOpen(sp, ".vault-sync-exclusion-modal");
            await shotModal(sp, lang, tag, "scr-exclusion", "exclusion modal");
            await sp.fill(".vault-sync-exclusion-add-input", "Welc");
            await sleep(500);
            await shot(sp, lang, `${tag}-scr-exclusion-typing`);
            await escape(sp);

            // The list for this device only: its own note, no toggle-managed rows,
            // and the patterns kept in this device's settings
            const buttons = sp.locator(".vault-sync-settings-page button").filter({ hasText: /Configure|Edit|設定|編集|管理|配置|编辑|설정|편집/ });
            if ((await buttons.count()) >= 2) {
                await buttons.nth(1).click();
                await modalOpen(sp, ".vault-sync-exclusion-modal");
                const info = await sp.evaluate(() => {
                    const m = document.querySelector(".vault-sync-exclusion-modal");
                    return {
                        title: m?.querySelector(".modal-title")?.textContent ?? "",
                        note: m?.querySelector(".vault-sync-exclusion-note")?.textContent ?? "",
                        managed: m?.querySelectorAll(".vault-sync-exclusion-item-managed").length ?? -1,
                    };
                });
                check(
                    lang,
                    `${tag}: PC exclusion list has its own title and note, without toggle rows`,
                    /PC/.test(info.title) && info.note.length > 0 && info.managed === 0,
                    JSON.stringify(info),
                );
                await sp.fill(".vault-sync-exclusion-add-input", "Archive/**");
                await sp.press(".vault-sync-exclusion-add-input", "Enter");
                await sleep(300);
                await shotModal(sp, lang, tag, "scr-device-exclusion", "device exclusion modal");
                const saved = await page.evaluate((id) => {
                    const pl = window.app.plugins.plugins[id];
                    return { device: pl.settings.desktopExclusionPatterns, shared: pl.settings.exclusionPatterns };
                }, PLUGIN_ID);
                check(
                    lang,
                    `${tag}: PC exclusion saved apart from the shared list`,
                    saved.device === "Archive/**" && !saved.shared.includes("Archive/**"),
                    JSON.stringify(saved),
                );
                await escape(sp);
                await page.evaluate(async (id) => {
                    const pl = window.app.plugins.plugins[id];
                    pl.settings.desktopExclusionPatterns = "";
                    await pl.saveSettings();
                }, PLUGIN_ID);
            } else {
                check(lang, `${tag}: device exclusion button found`, false);
            }
        } else {
            check(lang, `${tag}: exclusion button found on "${scopeName[2]}"`, false);
        }
    }
    await closeSettings(page);

    // Near-realtime: coming back to the front and the network coming back start a sync
    {
        const setVisibility = (state) =>
            page.evaluate((st) => {
                Object.defineProperty(document, "visibilityState", { configurable: true, get: () => st });
                document.dispatchEvent(new Event("visibilitychange"));
            }, state);
        await page.evaluate((id) => {
            const pl = window.app.plugins.plugins[id];
            window.__syncCalls = [];
            window.__realRequest = pl.syncManager.requestSmartSync;
            pl.syncManager.requestSmartSync = async (trigger) => {
                window.__syncCalls.push(trigger);
            };
            pl.triggerManager.setReady(true);
            pl.triggerManager.destroy(); // no timer sync in between
        }, PLUGIN_ID);
        await setVisibility("hidden");
        await sleep(3300);
        await setVisibility("visible");
        await sleep(200);
        const afterResume = await page.evaluate(() => window.__syncCalls.filter((t) => t !== "modify-sync").length);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await sleep(200);
        const calls = await page.evaluate((id) => {
            const pl = window.app.plugins.plugins[id];
            pl.syncManager.requestSmartSync = window.__realRequest;
            delete document.visibilityState;
            pl.triggerManager.setupAutoSyncInterval();
            return window.__syncCalls;
        }, PLUGIN_ID);
        // A hide with waiting changes sends them at once ("modify-sync"); resume and online are the rest.
        const others = calls.filter((t) => t !== "modify-sync");
        check(lang, `${tag}: back to the front starts a sync`, afterResume === 1, JSON.stringify(calls));
        check(lang, `${tag}: network back starts a sync`, others.length === 2, JSON.stringify(calls));
        check(lang, `${tag}: going to the background sends waiting changes at most once`, calls.filter((t) => t === "modify-sync").length <= 1, JSON.stringify(calls));
    }

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
        const entry = page.locator(".menu .menu-item").filter({ hasText: "Vault Syncer" });
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
        await input.fill("Vault Syncer");
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

/**
 * Add-on pages (needs ADDON_ZIP): install the add-on from Settings › Add-ons the
 * way a user does, then check that its own page is listed, opens, shows only the
 * actions that fit the state, runs them, is found by the search, and that its
 * actions are commands. The add-on is removed again at the end so the other
 * checks see the plugin without it.
 */
async function checkAddonPages(main, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    const page = await openSettings(main);
    if (page !== main) await page.setViewportSize(mobile ? MOBILE : DESKTOP).catch(() => {});
    const target = !mobile && (await page.$(".modal.mod-settings")) ? ".modal.mod-settings" : undefined;
    const addonTitle = await main.evaluate((id) => window.app.plugins.plugins[id].t("addonSectionTitle"), PLUGIN_ID);
    const names = await navNames(page);
    const items = await page.$$(".vault-sync-settings-nav-item");
    await items[names.indexOf(addonTitle)].click();
    await page.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
    check(
        lang,
        `${tag}: add-on list has no add-on page before install`,
        (await page.$$(".vault-sync-addon-page-row")).length === 0,
    );

    // Install through the button on the add-on page
    await page.locator(".vault-sync-settings-page .setting-item button").first().click();
    await modalOpen(page, ".vault-sync-addon-install");
    await page.setInputFiles(".vault-sync-addon-install input[type=file]", process.env.ADDON_ZIP);
    await page.waitForSelector(".vault-sync-addon-terms", { timeout: 10000 });
    await page.locator(".vault-sync-addon-install .checkbox-container").last().click();
    await page.locator(".vault-sync-addon-install button.mod-cta").last().click();
    // The install dialog closes and the settings move on to the add-on's own page
    await page.waitForSelector(".vault-sync-addon-page", { timeout: 10000 }).catch(() => {});
    // Phone dialogs slide out: wait until the install dialog is really gone
    await page.waitForSelector(".vault-sync-addon-install", { state: "detached", timeout: 5000 }).catch(() => {});
    await sleep(300);
    const onPage = await page.$(".vault-sync-addon-page");
    check(lang, `${tag}: after install the add-on page opens by itself`, !!onPage);
    if (!onPage) {
        await shot(page, lang, `${tag}-addon-install-error`);
        return;
    }
    const state = () =>
        page.evaluate(() => ({
            title: document
                .querySelector(".vault-sync-settings-page-title .setting-item-name")
                ?.textContent.trim(),
            rows: [...document.querySelectorAll(".vault-sync-addon-page .setting-item")].map((r) => ({
                name: r.querySelector(".setting-item-name")?.textContent.trim() ?? "",
                button: r.querySelector("button")?.textContent.trim() ?? null,
                cta: !!r.querySelector("button.mod-cta"),
                toggle: !!r.querySelector(".checkbox-container"),
            })),
        }));
    let st = await state();
    const buttons = st.rows.filter((r) => r.button);
    check(lang, `${tag}: add-on page has a title from the add-on`, !!st.title && st.title !== addonTitle, st.title);
    check(
        lang,
        `${tag}: before set-up only the start action is offered`,
        buttons.length === 1 && buttons[0].cta && !st.rows.some((r) => r.toggle),
        JSON.stringify(st.rows),
    );
    await shotSettings(page, lang, `${tag}-addon-page-setup`, target);

    // Run the action from its button: the add-on's dialog opens over the settings
    const modalsBefore = await page.$$eval(".modal-container", (els) => els.length);
    await page.locator(".vault-sync-addon-page button.mod-cta").first().click();
    await sleep(800);
    const modalsAfter = await page.$$eval(".modal-container", (els) => els.length);
    check(lang, `${tag}: start action opens the add-on's dialog`, modalsAfter > modalsBefore, `${modalsBefore} -> ${modalsAfter}`);
    if (modalsAfter > modalsBefore) await shot(page, lang, `${tag}-addon-action-dialog`);
    await page.keyboard.press("Escape");
    await sleep(400);

    // Commands: the same actions are in the palette, and follow the state
    const ids = ["e2ee-setup", "e2ee-unlock", "e2ee-change-password", "e2ee-show-recovery", "e2ee-recover"];
    const cmds = await main.evaluate(
        ({ id, ids }) => ids.map((c) => {
            const cmd = window.app.commands.commands[`${id}:${c}`];
            return cmd ? !!cmd.checkCallback(true) : null;
        }),
        { id: PLUGIN_ID, ids },
    );
    check(
        lang,
        `${tag}: add-on actions are commands, only start applies now`,
        JSON.stringify(cmds) === JSON.stringify([true, false, false, false, false]),
        JSON.stringify(cmds),
    );

    // Locked state (set up on another device): unlock and recover, plus auto-unlock
    await main.evaluate((id) => {
        const p = window.app.plugins.plugins[id];
        p.settings.e2eeEnabled = true;
        p.refreshSettingsUI();
    }, PLUGIN_ID);
    await sleep(300);
    st = await state();
    const locked = st.rows.filter((r) => r.button);
    check(
        lang,
        `${tag}: locked state offers unlock (main) and recover, and auto-unlock`,
        locked.length === 2 && locked[0].cta && !locked[1].cta && st.rows.some((r) => r.toggle),
        JSON.stringify(st.rows),
    );
    await shotSettings(page, lang, `${tag}-addon-page-locked`, target);

    // Back goes to the add-on list, which now lists the page
    await page.click(".vault-sync-settings-back");
    await page.waitForSelector(".vault-sync-addon-page-row", { timeout: 5000 }).catch(() => {});
    const rowName = await page
        .$eval(".vault-sync-addon-page-row .setting-item-name", (e) => e.textContent.trim())
        .catch(() => null);
    check(lang, `${tag}: add-on list shows the add-on page`, rowName === st.title, String(rowName));
    await shotSettings(page, lang, `${tag}-addon-list`, target);

    // Search finds the add-on's rows and leads to its page
    await page.click(".vault-sync-settings-back");
    await page.waitForSelector(".vault-sync-settings-search input", { timeout: 5000 });
    const word = locked[1].name;
    await page.fill(".vault-sync-settings-search input", word);
    await sleep(400);
    const groups = await page.$$eval(".vault-sync-settings-search-group", (els) =>
        els.map((e) => e.textContent.trim()),
    );
    const hit = groups.find((g) => g.startsWith(addonTitle) && g.includes(st.title));
    check(lang, `${tag}: search finds the add-on page rows`, !!hit, `"${word}" -> ${groups.join(" | ")}`);
    await shotSettings(page, lang, `${tag}-addon-search`, target);
    if (hit) {
        await page.locator(".vault-sync-settings-search-group a").filter({ hasText: st.title }).first().click();
        await sleep(300);
        check(lang, `${tag}: search group opens the add-on page`, !!(await page.$(".vault-sync-addon-page")));
    }

    // Clean up: back to the plain plugin
    const removed = await main.evaluate(async (id) => {
        const p = window.app.plugins.plugins[id];
        p.settings.e2eeEnabled = false;
        return p.removeAddon();
    }, PLUGIN_ID);
    await sleep(300);
    check(lang, `${tag}: add-on removed again`, removed && (await page.$$(".vault-sync-addon-page")).length === 0);
    await closeSettings(main);
    await closeModals(main);
}

/**
 * Proposals of 2026-11-24: sync check, files left out here fetched one by one,
 * cloud storage line, large-transfer deferral settings, file explorer marks.
 * The cloud parts are stubbed on the plugin object (no account here).
 */
async function checkNewFeatures(page, lang, { mobile = false } = {}) {
    const tag = mobile ? "mobile" : "desktop";
    const plugin = (fn, arg) =>
        page.evaluate(
            ([id, body, a]) => new Function("p", "a", body)(window.app.plugins.plugins[id], a),
            [PLUGIN_ID, fn, arg],
        );

    // Sync check, signed out: asks for the log-in, changes nothing
    await cmd(page, "verify-sync");
    await modalOpen(page, ".vault-sync-verify-modal");
    await sleep(1500);
    const signedOut = await page.$eval(".vault-sync-verify-modal .modal-content", (e) => e.textContent);
    check(lang, `${tag}: sync check asks for the log-in when signed out`, /log in|ログイン|登录|로그인/i.test(signedOut), signedOut.slice(0, 80));
    await shotModal(page, lang, tag, "scr-verify-signed-out", "sync check (signed out)");
    await escape(page);

    // Sync check with a report
    await plugin(`
        p.syncManager.__verify = p.syncManager.verifySync;
        p.syncManager.verifySync = async () => ({
            checkedAt: Date.now(), matching: 128, pending: 1,
            differences: [
                { path: "Daily/2026-11-24.md", kind: "local-changed" },
                { path: "Projects/plan.canvas", kind: "cloud-changed" },
                { path: "Inbox/idea.md", kind: "local-only" },
                { path: "Attachments/scan.pdf", kind: "cloud-only" },
            ],
        });`);
    await cmd(page, "verify-sync");
    await modalOpen(page, ".vault-sync-verify-group");
    await page.$$eval(".vault-sync-verify-group", (els) => els.forEach((e) => (e.open = true)));
    await sleep(300);
    const groups = await page.$$eval(".vault-sync-verify-group summary", (els) => els.map((e) => e.textContent));
    check(lang, `${tag}: sync check lists each kind of difference`, groups.length === 4, groups.join(" | "));
    await shotModal(page, lang, tag, "scr-verify-report", "sync check (report)");
    await escape(page);
    await plugin(`p.syncManager.verifySync = p.syncManager.__verify;`);

    // Files left out here: the picker lists them with their size
    await plugin(`
        p.syncManager.__list = p.syncManager.listCloudOnlyFiles;
        p.syncManager.listCloudOnlyFiles = async () => [
            { path: "Attachments/manual.pdf", size: 48234567, fileId: "x1" },
            { path: "Attachments/video.mp4", size: 268435456, fileId: "x2" },
        ];`);
    await cmd(page, "fetch-cloud-only");
    await page.waitForSelector(".prompt .suggestion-item", { timeout: 5000 });
    await sleep(300);
    const picks = await page.$$eval(".prompt .suggestion-item", (els) => els.map((e) => e.textContent));
    check(lang, `${tag}: left-out files picker lists the cloud files`, picks.length === 2 && picks.some((t) => t.includes("MB")), picks.join(" | "));
    await shot(page, lang, `${tag}-scr-cloud-only-picker`);
    await page.keyboard.press("Escape");
    await sleep(300);
    await plugin(`p.syncManager.listCloudOnlyFiles = p.syncManager.__list;`);

    // Cloud storage line on the data protection page
    await plugin(`
        const ad = p.syncManager.adapter;
        ad.getStorageQuota = async () => ({ usage: 13.8 * 1024 ** 3, limit: 15 * 1024 ** 3, usageInTrash: 320 * 1024 ** 2 });
        return p.syncManager.loadStorageSummary(true);`);
    const sp = await openSettings(page);
    if (sp !== page) await sp.setViewportSize(mobile ? MOBILE : DESKTOP).catch(() => {});
    const names = await navNames(sp);
    const prot = names.findIndex((n) => /^(Data protection and restore|データ保護・復元|数据保护与恢复|데이터 보호·복원)$/.test(n));
    if (prot >= 0) {
        await (await sp.$$(".vault-sync-settings-nav-item"))[prot].click();
        await sp.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const row = sp.locator(".vault-sync-settings-page .setting-item").filter({ hasText: /15\.0 GB/ });
        check(lang, `${tag}: storage line shows the account's use`, (await row.count()) === 1, "");
        if (await row.count()) await row.first().scrollIntoViewIfNeeded();
        await sleep(300);
        await shot(sp, lang, `${tag}-settings-storage`);
        await sp.click(".vault-sync-settings-back");
        await sleep(300);
    }
    const tr = (await navNames(sp)).findIndex((n) => /^(Transfers|転送|传输|전송)$/.test(n));
    if (tr >= 0) {
        await (await sp.$$(".vault-sync-settings-nav-item"))[tr].click();
        await sp.waitForSelector(".vault-sync-settings-back", { timeout: 5000 });
        const toggles = await sp.$$eval(".vault-sync-settings-page .setting-item .checkbox-container", (els) => els.length);
        check(lang, `${tag}: transfer page has the two deferral switches`, toggles >= 2, `toggles=${toggles}`);
        await shot(sp, lang, `${tag}-settings-transfer-defer`);
    }
    await closeSettings(page);

    // File explorer marks (desktop: the explorer is in view)
    if (!mobile) {
        const copy = "Welcome (Conflict 2026-11-24T09-00-00).md";
        await plugin(`
            p.settings.showFileExplorerMarks = true;
            p.syncManager.dirtyPaths.set("Welcome.md", Date.now());
            p.refreshFileExplorerMarks();`);
        await page.evaluate(async (f) => {
            if (!window.app.vault.getAbstractFileByPath(f)) await window.app.vault.create(f, "copy");
        }, copy);
        await sleep(1200);
        await plugin(`p.fileMarks.refresh();`);
        const marks = await page.$$eval(".nav-file-title.vault-sync-mark-pending, .nav-file-title.vault-sync-mark-conflict", (els) =>
            els.map((e) => e.className),
        );
        check(lang, `${tag}: file explorer marks the waiting file and the conflict copy`, marks.length === 2, marks.join(" | "));
        await shot(page, lang, `${tag}-scr-file-marks`, ".workspace-split.mod-left-split");
        await plugin(`
            p.settings.showFileExplorerMarks = false;
            p.syncManager.dirtyPaths.delete("Welcome.md");
            p.refreshFileExplorerMarks();`);
        await page.evaluate(async (f) => {
            const file = window.app.vault.getAbstractFileByPath(f);
            if (file) await window.app.fileManager.trashFile(file);
        }, copy);
        const left = await page.$$eval(".vault-sync-mark-pending, .vault-sync-mark-conflict", (els) => els.length);
        check(lang, `${tag}: marks are gone when turned off`, left === 0, `left=${left}`);
    }
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
        await checkProtectionAndNumbers(page, lang).catch(async (e) => {
            check(lang, "desktop: protection and numbers run completed", false, e.stack || String(e));
            await closeModals(page);
        });
        await checkScopeAndMassChange(page, lang).catch(async (e) => {
            check(lang, "desktop: scope and mass change run completed", false, e.stack || String(e));
            await closeModals(page);
        });
        await checkScreens(page, lang).catch(async (e) => {
            check(lang, "desktop: screens run completed", false, e.stack || String(e));
            await shot(page, lang, "desktop-scr-error").catch(() => {});
            await closeModals(page);
        });
        await checkNewFeatures(page, lang).catch(async (e) => {
            check(lang, "desktop: new features run completed", false, e.stack || String(e));
            await shot(page, lang, "desktop-new-error").catch(() => {});
            await closeModals(page);
        });
        if (process.env.ADDON_ZIP) {
            await checkAddonPages(page, lang).catch(async (e) => {
                check(lang, "desktop: add-on pages run completed", false, e.stack || String(e));
                await shot(page, lang, "desktop-addon-error").catch(() => {});
                await closeModals(page);
            });
        }

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
            await checkProtectionAndNumbers(page, lang, { mobile: true }).catch(async (e) => {
                check(lang, "mobile: protection and numbers run completed", false, e.stack || String(e));
                await closeModals(page);
            });
            await checkScopeAndMassChange(page, lang, { mobile: true }).catch(async (e) => {
                check(lang, "mobile: scope and mass change run completed", false, e.stack || String(e));
                await closeModals(page);
            });
            await checkScreens(page, lang, { mobile: true }).catch(async (e) => {
                check(lang, "mobile: screens run completed", false, e.stack || String(e));
                await shot(page, lang, "mobile-scr-error").catch(() => {});
            });
            await checkNewFeatures(page, lang, { mobile: true }).catch(async (e) => {
                check(lang, "mobile: new features run completed", false, e.stack || String(e));
                await shot(page, lang, "mobile-new-error").catch(() => {});
                await closeModals(page);
            });
            if (process.env.ADDON_ZIP) {
                await checkAddonPages(page, lang, { mobile: true }).catch(async (e) => {
                    check(lang, "mobile: add-on pages run completed", false, e.stack || String(e));
                    await shot(page, lang, "mobile-addon-error").catch(() => {});
                    await closeModals(page);
                });
            }
        }
    } catch (e) {
        check(lang, "run completed", false, e.stack || String(e));
        await shot(page, lang, "error").catch(() => {});
    } finally {
        await browser.close().catch(() => {});
        await stopAndRemove(proc, root);
    }
}

// ---------------------------------------------------------------------------
// Real sync inside Obsidian, against a Drive-like server
// ---------------------------------------------------------------------------

/**
 * FakeDriveServer (tests/helpers) behind a local HTTP server that answers like
 * googleapis.com across origins (CORS, Location and Range exposed). The plugin's
 * own Drive transport is pointed at it; everything else (vault events, the
 * Obsidian vault API, the sync engine, the Drive adapter) is what ships.
 */
async function startFakeDrive() {
    const { build } = await import("esbuild");
    const out = await build({
        entryPoints: ["tests/helpers/fake-drive-server.ts"],
        bundle: true,
        format: "esm",
        platform: "node",
        write: false,
        alias: { obsidian: "./tests/browser/obsidian-stub.ts" },
        logLevel: "silent",
    });
    const dir = mkdtempSync(join(tmpdir(), "fake-drive-"));
    const file = join(dir, "fake-drive-server.mjs");
    writeFileSync(file, out.outputFiles[0].text);
    const { FakeDriveServer } = await import(file);
    const drive = new FakeDriveServer();
    const http = await import("node:http");
    const server = http.createServer(async (req, res) => {
        const cors = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
            "Access-Control-Allow-Headers": "Authorization, Content-Type, Content-Range, X-Upload-Content-Type, X-Upload-Content-Length",
            "Access-Control-Expose-Headers": "Location, Range",
        };
        try {
            if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
            const m = /^\/__host\/([^/]+)(\/.*)$/.exec(req.url ?? "");
            if (!m) return void res.writeHead(404, cors).end();
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = Buffer.concat(chunks);
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
            if (process.env.E2E_TRACE) console.log(`[drive] ${req.method} ${m[2].slice(0, 160)}`);
            const answer = await drive.fetch(`https://${m[1]}${m[2]}`, {
                method: req.method,
                headers,
                body: body.byteLength ? new Uint8Array(body) : undefined,
            });
            const outHeaders = { ...cors };
            answer.headers.forEach((v, k) => (outHeaders[k] = v));
            res.writeHead(answer.status, outHeaders).end(Buffer.from(await answer.arrayBuffer()));
        } catch (e) {
            if (!res.headersSent) res.writeHead(500, cors);
            res.end(String(e));
        }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    /** Another device's request, straight to the server */
    const api = async (method, path, body) => {
        const r = await drive.fetch(`https://www.googleapis.com${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
        });
        return r.status === 204 ? null : r.json();
    };
    return { drive, origin, api, close: () => new Promise((r) => server.close(r)), dir };
}

/**
 * Stops Obsidian and removes its temporary folders. Waits for the process to be
 * gone first: one still writing its log made the removal fail (ENOTEMPTY) and
 * with it the whole run. A folder that cannot be removed is only reported.
 */
async function stopAndRemove(proc, ...dirs) {
    const gone = new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", r)));
    proc.kill("SIGTERM");
    await Promise.race([gone, sleep(3000)]);
    if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
        await Promise.race([gone, sleep(3000)]);
    }
    for (const dir of dirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (e) {
            console.warn(`Could not remove ${dir}: ${e}`);
        }
    }
}

function withTimeout(ms, what, p) {
    let timer;
    return Promise.race([
        p.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms))),
    ]);
}

async function checkRealSync() {
    const lang = "sync";
    const step = (m) => process.env.E2E_TRACE && console.log(`[sync] ${m}`);
    const fake = await startFakeDrive();
    step(`fake Drive at ${fake.origin}`);
    const root = mkdtempSync(join(tmpdir(), "obsidian-e2e-sync-"));
    const { proc, browser, page } = await launch(root);
    page.on("pageerror", (e) => consoleErrors.push({ lang, kind: "pageerror", text: String(e.stack || e) }));
    page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push({ lang, kind: "console", text: m.text() });
        if (process.env.E2E_TRACE && m.text().includes("Vault Syncer")) console.log(`[page] ${m.text().slice(0, 300)}`);
    });
    try {
        await page.setViewportSize(DESKTOP);
        await prepare(page, "en");
        const vaultName = await page.evaluate(() => window.app.vault.getName());
        // Signed in (tokens only) and the Drive requests sent to the local server
        await page.evaluate(
            ({ id, origin, trace }) => {
                const p = window.app.plugins.plugins[id];
                const ad = p.syncManager.adapter;
                const C = ad.http.constructor;
                const send = C.transport;
                C.transport = (url, init, o) => {
                    const u = new URL(url);
                    return send(`${origin}/__host/${u.host}${u.pathname}${u.search}`, init, o);
                };
                if (trace) {
                    const f = ad.http.fetchWithAuth.bind(ad.http);
                    ad.http.fetchWithAuth = async (url, ...rest) => {
                        const tag = String(url).replace("https://www.googleapis.com", "").slice(0, 90);
                        console.log(`Vault Syncer trace > ${tag}`);
                        try {
                            const r = await f(url, ...rest);
                            console.log(`Vault Syncer trace < ${r.status} ${tag}`);
                            return r;
                        } catch (e) {
                            console.log(`Vault Syncer trace ! ${tag} ${e}`);
                            throw e;
                        }
                    };
                }
                ad.auth.accessToken = "fake-access-token";
                ad.auth.refreshToken = "fake-refresh-token";
                ad.auth.tokenExpiresAt = Date.now() + 3600 * 1000;
                window.__syncErrors = [];
            },
            { id: PLUGIN_ID, origin: fake.origin, trace: !!process.env.E2E_TRACE },
        );
        const sync = (trigger = "manual-sync") =>
            withTimeout(60000, `sync (${trigger})`, page.evaluate(
                async ({ id, trigger }) => {
                    const p = window.app.plugins.plugins[id];
                    await p.syncManager.requestSmartSync(trigger, trigger === "initial-sync");
                    for (let i = 0; i < 100 && p.syncManager.isSyncing?.(); i++) await new Promise((r) => setTimeout(r, 100));
                },
                { id: PLUGIN_ID, trigger },
            )).catch(async (e) => {
                if (process.env.E2E_TRACE) {
                    await page.screenshot({ path: join(tmpdir(), "e2e-sync-hang.png") }).catch(() => {});
                    console.log(`[sync] modal text: ${await page.evaluate(() => [...document.querySelectorAll(".modal")].map((m) => m.textContent).join(" | ")).catch(() => "?")}`);
                }
                throw e;
            });
        const vault = () =>
            page.evaluate(async () => {
                const out = {};
                for (const f of window.app.vault.getFiles()) out[f.path] = await window.app.vault.read(f);
                const folders = window.app.vault
                    .getAllLoadedFiles()
                    .filter((f) => f.children && f.path !== "/")
                    .map((f) => f.path)
                    .sort();
                return { files: out, folders };
            });
        const cloud = () => {
            const out = {};
            for (const [p, it] of fake.drive.vaultItems(vaultName)) {
                if (p.startsWith(".obsidian")) continue;
                out[p] = it.folder ? "/" : Buffer.from(it.content ?? []).toString("utf8");
            }
            return out;
        };
        const settle = () => sleep(1500); // vault events of the sync's own writes

        step('1. First sync');
        // 1. First sync uploads the vault, one folder per folder
        await page.evaluate(async () => {
            await window.app.vault.createFolder("Notes");
            await window.app.vault.create("Notes/a.md", "a1\n");
            await window.app.vault.create("Notes/c.md", "c1\n");
        });
        await sleep(500);
        await sync("initial-sync");
        await settle();
        await sync();
        let c = cloud();
        check(
            lang,
            "first sync uploads the vault to Drive",
            c["Welcome.md"] === "# E2E vault\n" && c["Notes/a.md"] === "a1\n" && c["Notes/c.md"] === "c1\n" && c["Notes/"] === "/" && !c["Notes #2/"],
            JSON.stringify(c),
        );

        step('2. An edit');
        // 2. An edit in Obsidian reaches Drive (vault modify event)
        await page.evaluate(async () => {
            await window.app.vault.modify(window.app.vault.getAbstractFileByPath("Notes/a.md"), "a1\na2\n");
        });
        await sleep(500);
        await sync();
        check(lang, "an edit in Obsidian reaches Drive", cloud()["Notes/a.md"] === "a1\na2\n", JSON.stringify(cloud()));

        step('3. Another device');
        // 3. Another device renames the folder and adds a note to it
        const notes = (await fake.api("GET", `/drive/v3/files?q=${encodeURIComponent("name = 'Notes' and trashed = false")}&fields=files(id)`)).files[0];
        await fake.api("PATCH", `/drive/v3/files/${notes.id}`, { name: "Archive" });
        const boundary = "e2e";
        const mp = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: "b.md", parents: [notes.id] })}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\nb from another device\n\r\n--${boundary}--`;
        await fake.drive.fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body: new TextEncoder().encode(mp),
        });
        await sync();
        await settle();
        await sync();
        let v = await vault();
        check(
            lang,
            "a folder renamed on another device is followed in Obsidian",
            v.files["Archive/a.md"] === "a1\na2\n" && v.files["Archive/c.md"] === "c1\n" && v.files["Archive/b.md"] === "b from another device\n" && !v.folders.includes("Notes"),
            JSON.stringify(v),
        );
        check(lang, "the folder is not made again on Drive under its old name", !("Notes/" in cloud()), JSON.stringify(cloud()));

        step('4. A folder renamed');
        // 4. A folder renamed in Obsidian: one folder on Drive, notes inside
        await page.evaluate(async () => {
            await window.app.fileManager.renameFile(window.app.vault.getAbstractFileByPath("Archive"), "Work");
        });
        await sleep(800);
        await sync();
        await settle();
        await sync();
        c = cloud();
        check(
            lang,
            "a folder renamed in Obsidian is one folder on Drive with its notes",
            c["Work/"] === "/" && c["Work/a.md"] === "a1\na2\n" && c["Work/b.md"] && c["Work/c.md"] && !c["Archive/"] && !c["Work #2/"],
            JSON.stringify(c),
        );

        step('5. A note deleted');
        // 5. A note deleted in Obsidian is deleted on Drive
        await page.evaluate(async () => {
            await window.app.vault.delete(window.app.vault.getAbstractFileByPath("Work/c.md"));
        });
        await sleep(500);
        await sync();
        check(lang, "a note deleted in Obsidian is deleted on Drive", !("Work/c.md" in cloud()) && "Work/a.md" in cloud(), JSON.stringify(cloud()));

        step('6. Nothing changed');
        // 6. Nothing changed: a sync changes nothing on Drive
        const before = fake.drive.requests.filter((r) => !r.startsWith("GET")).length;
        await sync();
        const writes = fake.drive.requests.filter((r) => !r.startsWith("GET")).slice(before);
        check(
            lang,
            "an idle sync writes nothing to Drive except its own status",
            writes.every((r) => /upload\/drive\/v3\/files\/[^/]+$|\/files\/[^/]+$/.test(r)) && writes.length <= 4,
            writes.join(", "),
        );
        await shot(page, lang, "real-sync-done");
    } catch (e) {
        check(lang, "real sync run completed", false, e.stack || String(e));
        await shot(page, lang, "real-sync-error").catch(() => {});
    } finally {
        await browser.close().catch(() => {});
        await fake.close();
        await stopAndRemove(proc, root, fake.dir);
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
    if (process.env.E2E_SYNC !== "0") await checkRealSync();
    if (process.env.E2E_SYNC !== "only") for (const lang of LANGS) await runLang(lang);
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
