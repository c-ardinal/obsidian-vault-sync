/**
 * @file ファイル同期フィルタリングのユニットテスト
 *
 * @description
 * isAlwaysForbiddenOnRemote / shouldNotBeOnRemote / isManagedSeparately / shouldIgnore の各フィルタ関数を検証する。
 * システムファイル(.DS_Store等)の強制除外、同期トグル設定(syncWorkspace/syncAppearance/syncCommunityPlugins等)に基づく条件付き除外、
 * 除外パターン(glob)によるユーザー定義除外を網羅する。
 *
 * @pass_criteria
 * - システムファイル・Obsidian一時ファイル・コンフリクトファイルが設定に関係なく除外されること
 * - 各同期トグルのON/OFFでファイルの許可/拒否が正しく切り替わること
 * - 除外パターン(glob)によるマッチングが正確であること
 * - 管理ファイル(sync-index.json等)がshouldIgnoreで除外されること
 */

import { describe, it, expect } from "vitest";
import {
    isAlwaysForbiddenOnRemote,
    shouldNotBeOnRemote,
    shouldIgnore,
    isManagedSeparately,
} from "../../../src/sync-manager/file-utils";
import type { SyncContext } from "../../../src/sync-manager/context";

/** Minimal mock SyncContext with all sync toggles enabled by default */
function makeCtx(overrides: Partial<SyncContext["settings"]> = {}): SyncContext {
    return {
        settings: {
            syncWorkspace: true,
            syncAppearance: true,
            syncCommunityPlugins: true,
            syncCoreConfig: true,
            syncImagesAndMedia: true,
            syncDotfiles: true,
            syncFlexibleData: true,
            syncDeviceLogs: true,
            exclusionPatterns: "",
            ...overrides,
        },
    } as unknown as SyncContext;
}

// ═════════════════════════════════════════════════════════════════════
// isAlwaysForbiddenOnRemote
// ═════════════════════════════════════════════════════════════════════

describe("isAlwaysForbiddenOnRemote", () => {
    describe("plugin internal local-only files", () => {
        it("should forbid cache/ under plugin dir", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/plugins/obsidian-vault-sync/cache/data.bin")).toBe(true);
        });

        it("should forbid data/local/ under plugin dir", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/plugins/obsidian-vault-sync/data/local/settings.json")).toBe(true);
        });

        it("should allow data/remote/ under plugin dir", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json")).toBe(false);
        });

        it("should allow logs/ under plugin dir (settings-dependent, not system-level)", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/plugins/obsidian-vault-sync/logs/dev1/log.txt")).toBe(false);
        });
    });

    describe("system-level ignore files", () => {
        it("should forbid .DS_Store at root", () => {
            expect(isAlwaysForbiddenOnRemote(".DS_Store")).toBe(true);
        });

        it("should forbid .DS_Store in subdirectory", () => {
            expect(isAlwaysForbiddenOnRemote("notes/subfolder/.DS_Store")).toBe(true);
        });

        it("should forbid Thumbs.db", () => {
            expect(isAlwaysForbiddenOnRemote("Thumbs.db")).toBe(true);
        });

        it("should forbid Thumbs.db in nested path", () => {
            expect(isAlwaysForbiddenOnRemote("images/photos/Thumbs.db")).toBe(true);
        });

        it("should forbid _VaultSync_Debug.log", () => {
            expect(isAlwaysForbiddenOnRemote("_VaultSync_Debug.log")).toBe(true);
        });

        it("should forbid _VaultSync_Orphans/ directory", () => {
            expect(isAlwaysForbiddenOnRemote("_VaultSync_Orphans/orphan1.md")).toBe(true);
        });
    });

    describe("obsidian system transient files", () => {
        it("should forbid .obsidian/cache/", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/cache/file.json")).toBe(true);
        });

        it("should forbid .obsidian/indexedDB/", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/indexedDB/db.bin")).toBe(true);
        });

        it("should forbid .obsidian/backups/", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/backups/backup.json")).toBe(true);
        });

        it("should forbid .obsidian/.trash/", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/.trash/deleted.md")).toBe(true);
        });

        it("should NOT forbid .obsidian/app.json (settings-dependent)", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/app.json")).toBe(false);
        });

        it("should NOT forbid .obsidian/workspace.json (settings-dependent)", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/workspace.json")).toBe(false);
        });

        it("should NOT forbid .obsidian/themes/ (settings-dependent)", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/themes/mytheme.css")).toBe(false);
        });

        it("should NOT forbid .obsidian/plugins/ (settings-dependent)", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/plugins/other-plugin/main.js")).toBe(false);
        });
    });

    describe("conflict resolution files", () => {
        it("should forbid conflict files with timestamp pattern", () => {
            expect(isAlwaysForbiddenOnRemote("notes/test (Conflict 2026-02-23T16-00-00).md")).toBe(true);
        });

        it("should forbid conflict files in subdirectory", () => {
            expect(isAlwaysForbiddenOnRemote("deep/path/file (Conflict 2025-12-31T23-59-59).txt")).toBe(true);
        });

        it("should NOT match non-conflict parenthetical", () => {
            expect(isAlwaysForbiddenOnRemote("notes/test (Copy).md")).toBe(false);
        });
    });

    describe("regular files allowed", () => {
        it("should allow normal markdown files", () => {
            expect(isAlwaysForbiddenOnRemote("notes/my-note.md")).toBe(false);
        });

        it("should allow images", () => {
            expect(isAlwaysForbiddenOnRemote("attachments/photo.png")).toBe(false);
        });

        it("should allow .obsidian config files", () => {
            expect(isAlwaysForbiddenOnRemote(".obsidian/app.json")).toBe(false);
        });

        it("should allow dotfiles outside .obsidian", () => {
            expect(isAlwaysForbiddenOnRemote(".gitignore")).toBe(false);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// shouldNotBeOnRemote
// ═════════════════════════════════════════════════════════════════════

describe("shouldNotBeOnRemote", () => {
    describe("system-level checks (independent of settings)", () => {
        it("should block .DS_Store regardless of settings", () => {
            expect(shouldNotBeOnRemote(makeCtx(), ".DS_Store")).toBe(true);
        });

        it("should block Thumbs.db regardless of settings", () => {
            expect(shouldNotBeOnRemote(makeCtx(), "Thumbs.db")).toBe(true);
        });

        it("should block plugin cache/ regardless of settings", () => {
            expect(shouldNotBeOnRemote(makeCtx(), ".obsidian/plugins/obsidian-vault-sync/cache/data.bin")).toBe(true);
        });

        it("should block .obsidian/cache/ regardless of settings", () => {
            expect(shouldNotBeOnRemote(makeCtx(), ".obsidian/cache/data.json")).toBe(true);
        });

        it("should block conflict files regardless of settings", () => {
            expect(shouldNotBeOnRemote(makeCtx(), "note (Conflict 2026-01-01T00-00-00).md")).toBe(true);
        });
    });

    // ─── syncWorkspace ───

    describe("syncWorkspace", () => {
        it("should allow workspace.json when syncWorkspace=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncWorkspace: true }), ".obsidian/workspace.json")).toBe(false);
        });

        it("should block workspace.json when syncWorkspace=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncWorkspace: false }), ".obsidian/workspace.json")).toBe(true);
        });

        it("should allow workspace-mobile.json when syncWorkspace=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncWorkspace: true }), ".obsidian/workspace-mobile.json")).toBe(false);
        });

        it("should block workspace-mobile.json when syncWorkspace=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncWorkspace: false }), ".obsidian/workspace-mobile.json")).toBe(true);
        });
    });

    // ─── syncAppearance ───

    describe("syncAppearance", () => {
        it("should allow themes when syncAppearance=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncAppearance: true }), ".obsidian/themes/mytheme.css")).toBe(false);
        });

        it("should block themes when syncAppearance=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncAppearance: false }), ".obsidian/themes/mytheme.css")).toBe(true);
        });

        it("should allow snippets when syncAppearance=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncAppearance: true }), ".obsidian/snippets/custom.css")).toBe(false);
        });

        it("should block snippets when syncAppearance=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncAppearance: false }), ".obsidian/snippets/custom.css")).toBe(true);
        });

        it("should not affect non-appearance .obsidian files", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncAppearance: false }), ".obsidian/app.json")).toBe(false);
        });
    });

    // ─── syncCommunityPlugins ───

    describe("syncCommunityPlugins", () => {
        it("should allow community plugins when syncCommunityPlugins=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncCommunityPlugins: true }), ".obsidian/plugins/dataview/main.js")).toBe(false);
        });

        it("should block community plugins when syncCommunityPlugins=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncCommunityPlugins: false }), ".obsidian/plugins/dataview/main.js")).toBe(true);
        });

        it("should block all files under .obsidian/plugins/ when false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncCommunityPlugins: false }), ".obsidian/plugins/templater/manifest.json")).toBe(true);
        });

        it("should not affect vault-sync's own internal files (caught by local-only check)", () => {
            // vault-sync cache is caught by INTERNAL_LOCAL_ONLY before community plugins check
            expect(shouldNotBeOnRemote(makeCtx({ syncCommunityPlugins: true }), ".obsidian/plugins/obsidian-vault-sync/cache/x")).toBe(true);
        });
    });

    // ─── syncCoreConfig ───

    describe("syncCoreConfig", () => {
        const coreFiles = [
            ".obsidian/app.json",
            ".obsidian/appearance.json",
            ".obsidian/hotkeys.json",
            ".obsidian/core-plugins.json",
            ".obsidian/community-plugins.json",
            ".obsidian/graph.json",
        ];

        for (const file of coreFiles) {
            it(`should allow ${file} when syncCoreConfig=true`, () => {
                expect(shouldNotBeOnRemote(makeCtx({ syncCoreConfig: true }), file)).toBe(false);
            });

            it(`should block ${file} when syncCoreConfig=false`, () => {
                expect(shouldNotBeOnRemote(makeCtx({ syncCoreConfig: false }), file)).toBe(true);
            });
        }

        it("should not affect non-core .obsidian files", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncCoreConfig: false }), ".obsidian/workspace.json")).toBe(false);
        });
    });

    // ─── syncImagesAndMedia ───

    describe("syncImagesAndMedia", () => {
        const mediaFiles = [
            "photo.png", "image.jpg", "pic.jpeg", "anim.gif",
            "icon.bmp", "vector.svg", "modern.webp",
            "song.mp3", "sound.wav", "audio.ogg", "music.m4a",
            "clip.mp4", "movie.mov", "video.webm",
            "document.pdf",
        ];

        for (const file of mediaFiles) {
            it(`should allow ${file} when syncImagesAndMedia=true`, () => {
                expect(shouldNotBeOnRemote(makeCtx({ syncImagesAndMedia: true }), `attachments/${file}`)).toBe(false);
            });

            it(`should block ${file} when syncImagesAndMedia=false`, () => {
                expect(shouldNotBeOnRemote(makeCtx({ syncImagesAndMedia: false }), `attachments/${file}`)).toBe(true);
            });
        }

        it("should allow markdown files even when syncImagesAndMedia=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncImagesAndMedia: false }), "notes/note.md")).toBe(false);
        });

        it("should allow text files even when syncImagesAndMedia=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncImagesAndMedia: false }), "notes/readme.txt")).toBe(false);
        });
    });

    // ─── syncDotfiles ───

    describe("syncDotfiles", () => {
        it("should allow dotfiles when syncDotfiles=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncDotfiles: true }), ".gitignore")).toBe(false);
        });

        it("should block dotfiles when syncDotfiles=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncDotfiles: false }), ".gitignore")).toBe(true);
        });

        it("should block .git/ when syncDotfiles=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncDotfiles: false }), ".git/config")).toBe(true);
        });

        it("should NOT block .obsidian/ when syncDotfiles=false (special-cased)", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncDotfiles: false }), ".obsidian/app.json")).toBe(false);
        });

        it("should NOT block .obsidian itself when syncDotfiles=false", () => {
            // .obsidian directory is always handled separately
            expect(shouldNotBeOnRemote(makeCtx({ syncDotfiles: false }), ".obsidian")).toBe(false);
        });
    });

    // ─── syncDeviceLogs ───

    describe("syncDeviceLogs", () => {
        const logPath = ".obsidian/plugins/obsidian-vault-sync/logs/dev1/sync.log";

        it("should allow logs when syncDeviceLogs=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncDeviceLogs: true }), logPath)).toBe(false);
        });

        it("should block logs when syncDeviceLogs=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncDeviceLogs: false }), logPath)).toBe(true);
        });
    });

    // ─── syncFlexibleData ───

    describe("syncFlexibleData", () => {
        const flexPath = ".obsidian/plugins/obsidian-vault-sync/data/flexible/open-data.json";

        it("should allow flexible data when syncFlexibleData=true", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncFlexibleData: true }), flexPath)).toBe(false);
        });

        it("should block flexible data when syncFlexibleData=false", () => {
            expect(shouldNotBeOnRemote(makeCtx({ syncFlexibleData: false }), flexPath)).toBe(true);
        });
    });

    // ─── exclusionPatterns ───

    describe("exclusionPatterns", () => {
        it("should block files matching a simple pattern at root", () => {
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: "*.tmp" }), "file.tmp")).toBe(true);
        });

        it("should block files matching a recursive glob pattern", () => {
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: "**/*.tmp" }), "data/file.tmp")).toBe(true);
        });

        it("should allow files not matching pattern", () => {
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: "*.tmp" }), "file.md")).toBe(false);
        });

        it("should support multiple patterns separated by newlines", () => {
            const patterns = "*.tmp\n*.bak\nsecret";
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: patterns }), "file.tmp")).toBe(true);
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: patterns }), "old.bak")).toBe(true);
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: patterns }), "secret/data.json")).toBe(true);
        });

        it("should ignore empty lines in patterns", () => {
            const patterns = "*.tmp\n\n\n*.bak";
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: patterns }), "file.md")).toBe(false);
        });

        it("should not block anything when patterns are empty", () => {
            expect(shouldNotBeOnRemote(makeCtx({ exclusionPatterns: "" }), "any/file.md")).toBe(false);
        });
    });

    // ─── all settings enabled: regular files allowed ───

    describe("all settings enabled (default)", () => {
        it("should allow normal markdown files", () => {
            expect(shouldNotBeOnRemote(makeCtx(), "notes/my-note.md")).toBe(false);
        });

        it("should allow workspace.json", () => {
            expect(shouldNotBeOnRemote(makeCtx(), ".obsidian/workspace.json")).toBe(false);
        });

        it("should allow .obsidian config", () => {
            expect(shouldNotBeOnRemote(makeCtx(), ".obsidian/app.json")).toBe(false);
        });

        it("should allow community plugin files", () => {
            expect(shouldNotBeOnRemote(makeCtx(), ".obsidian/plugins/dataview/main.js")).toBe(false);
        });

        it("should allow media files", () => {
            expect(shouldNotBeOnRemote(makeCtx(), "attachments/image.png")).toBe(false);
        });

        it("should allow dotfiles", () => {
            expect(shouldNotBeOnRemote(makeCtx(), ".gitignore")).toBe(false);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// isManagedSeparately
// ═════════════════════════════════════════════════════════════════════

describe("isManagedSeparately", () => {
    it("should identify sync-index.json as managed (bare path)", () => {
        expect(isManagedSeparately("data/remote/sync-index.json")).toBe(true);
    });

    it("should identify sync-index.json as managed (full plugin path)", () => {
        expect(isManagedSeparately(".obsidian/plugins/obsidian-vault-sync/data/remote/sync-index.json")).toBe(true);
    });

    it("should identify sync-index_raw.json as managed", () => {
        expect(isManagedSeparately("data/remote/sync-index_raw.json")).toBe(true);
    });

    it("should identify communication.json as managed", () => {
        expect(isManagedSeparately("data/remote/communication.json")).toBe(true);
    });

    it("should identify vault-lock.vault as managed", () => {
        expect(isManagedSeparately("data/remote/vault-lock.vault")).toBe(true);
    });

    it("should identify migration.lock as managed", () => {
        expect(isManagedSeparately("migration.lock")).toBe(true);
    });

    it("should NOT identify regular files as managed", () => {
        expect(isManagedSeparately("notes/test.md")).toBe(false);
    });

    it("should NOT identify unrelated plugin files as managed", () => {
        expect(isManagedSeparately(".obsidian/plugins/obsidian-vault-sync/manifest.json")).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// shouldIgnore (composite)
// ═════════════════════════════════════════════════════════════════════

describe("shouldIgnore", () => {
    it("should ignore managed files (sync-index.json)", () => {
        expect(shouldIgnore(makeCtx(), "data/remote/sync-index.json")).toBe(true);
    });

    it("should ignore files blocked by shouldNotBeOnRemote", () => {
        expect(shouldIgnore(makeCtx(), ".DS_Store")).toBe(true);
    });

    it("should ignore workspace.json when syncWorkspace=false", () => {
        expect(shouldIgnore(makeCtx({ syncWorkspace: false }), ".obsidian/workspace.json")).toBe(true);
    });

    it("should NOT ignore normal files", () => {
        expect(shouldIgnore(makeCtx(), "notes/test.md")).toBe(false);
    });

    it("should NOT ignore workspace.json when syncWorkspace=true", () => {
        expect(shouldIgnore(makeCtx({ syncWorkspace: true }), ".obsidian/workspace.json")).toBe(false);
    });
});
