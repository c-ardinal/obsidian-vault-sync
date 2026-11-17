/**
 * @file Plaintext hash of non-UTF-8 files, and the one-time migration of stored hashes
 *
 * @description
 * hashContent used to decode every file as text, turning each invalid byte into
 * U+FFFD, so binaries (or Shift_JIS notes) that differed only in such bytes had the
 * same hash and an edit was missed. Non-UTF-8 content is now hashed as raw bytes.
 * - hashContent tells such files apart; text keeps its old (CRLF/BOM-folded) hash
 * - legacyHashContent reproduces the old hash, only where it differs
 * - plainHashMatches accepts an old hash from an index written before the change
 * - migratePlainHashes converts this device's stored hashes once, local and remote
 *   copies alike, leaves changed files and text alone, and runs only with the add-on
 * - the version is persisted in the local index; an old local index counts as v1
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import {
    hashContent,
    legacyHashContent,
    plainHashMatches,
} from "../../../src/sync-manager/file-utils";
import {
    migratePlainHashes,
    plainHashVersion,
    restorePlainHashVersion,
    PLAIN_HASH_VERSION,
} from "../../../src/sync-manager/plain-hash-migration";
import { loadLocalIndex, saveLocalIndex } from "../../../src/sync-manager/state";
import type { SyncContext } from "../../../src/sync-manager/context";

const LOCAL = ".obsidian/plugins/obsidian-vault-sync/data/local/local-index.json";

const buf = (bytes: number[]) => new Uint8Array(bytes).buffer as ArrayBuffer;
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const rawMd5 = (b: ArrayBuffer) => createHash("md5").update(new Uint8Array(b)).digest("hex");
/** What hashContent computed before the change, for any input */
const oldHash = (b: ArrayBuffer) =>
    rawMd5(new TextEncoder().encode(new TextDecoder().decode(b).replace(/\r\n/g, "\n")).buffer as ArrayBuffer);

// Two PNG-like files differing only in invalid UTF-8 bytes (0xff vs 0xfe)
const binA = buf([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01]);
const binB = buf([0x89, 0x50, 0x4e, 0x47, 0xfe, 0x00, 0x01]);
// "日米" in Shift_JIS, then an edit of the second character (both bytes non-ASCII)
const sjisA = buf([0x93, 0xfa, 0x95, 0xc4, 0x0d, 0x0a]);
const sjisB = buf([0x93, 0xfa, 0x96, 0xc4, 0x0d, 0x0a]);

describe("hashContent", () => {
    it("tells apart non-UTF-8 files that differ only in invalid bytes", async () => {
        expect(oldHash(binA)).toBe(oldHash(binB)); // the bug
        expect(await hashContent(binA)).not.toBe(await hashContent(binB));
        expect(oldHash(sjisA)).toBe(oldHash(sjisB));
        expect(await hashContent(sjisA)).not.toBe(await hashContent(sjisB));
    });

    it("hashes non-UTF-8 content as raw bytes (no line-ending folding)", async () => {
        expect(await hashContent(binA)).toBe(rawMd5(binA));
        expect(await hashContent(sjisA)).toBe(rawMd5(sjisA));
    });

    it("keeps the hash of UTF-8 text unchanged (CRLF and BOM folded)", async () => {
        for (const s of ["", "plain\n", "a\r\nb\r\n", "﻿bom\r\n", "日本語\r\n", "lone\rcr"]) {
            expect(await hashContent(enc(s))).toBe(oldHash(enc(s)));
        }
        expect(await hashContent(enc("x\r\ny"))).toBe(await hashContent(enc("x\ny")));
    });
});

describe("legacyHashContent / plainHashMatches", () => {
    it("legacyHashContent gives the old hash, and null where it did not change", async () => {
        expect(legacyHashContent(binA)).toBe(oldHash(binA));
        expect(legacyHashContent(sjisA)).toBe(oldHash(sjisA));
        expect(legacyHashContent(enc("text\r\n"))).toBeNull();
    });

    it("accepts the new and the old hash of the same content, case-insensitively", async () => {
        expect(await plainHashMatches(await hashContent(binA), binA)).toBe(true);
        expect(await plainHashMatches(oldHash(binA).toUpperCase(), binA)).toBe(true);
        expect(await plainHashMatches(await hashContent(binA), binB)).toBe(false);
        expect(await plainHashMatches(undefined, binA)).toBe(false);
        expect(await plainHashMatches(oldHash(enc("a")), enc("b"))).toBe(false);
    });
});

function makeCtx(files: Record<string, ArrayBuffer>, overrides: Record<string, unknown> = {}) {
    const store = new Map(Object.entries(files));
    const ctx = {
        files: store,
        vault: {
            exists: vi.fn(async (p: string) => store.has(p)),
            read: vi.fn(async (p: string) => new TextDecoder().decode(store.get(p)!)),
            readBinary: vi.fn(async (p: string) => store.get(p)!.slice(0)),
            write: vi.fn(async (p: string, d: string) => {
                store.set(p, enc(d));
            }),
        },
        settings: { concurrency: 3 },
        index: {},
        localIndex: {},
        localIndexPath: LOCAL,
        pluginDir: ".obsidian/plugins/obsidian-vault-sync",
        logFolder: ".obsidian/plugins/obsidian-vault-sync/logs/dev_A",
        deviceId: "dev_A",
        e2eeEnabled: true,
        log: vi.fn(async () => {}),
        ...overrides,
    };
    return ctx as unknown as SyncContext & { files: Map<string, ArrayBuffer> };
}

const entry = (plainHash: string) => ({ fileId: "f", mtime: 1, size: 1, hash: "enc", plainHash }) as any;

describe("migratePlainHashes", () => {
    it("converts old hashes of unchanged non-UTF-8 files in both indexes, once", async () => {
        const ctx = makeCtx({ "img.png": binA, "note.md": enc("a\r\n"), "sjis.txt": sjisA });
        restorePlainHashVersion(ctx, undefined, false); // local index from an older version
        ctx.localIndex = {
            "img.png": entry(oldHash(binA)),
            "note.md": entry(oldHash(enc("a\r\n"))),
            "sjis.txt": entry(oldHash(sjisA)),
        };
        ctx.index = { "img.png": entry(oldHash(binA)), "note.md": entry(oldHash(enc("a\r\n"))) };

        expect(await migratePlainHashes(ctx)).toBe(2);
        expect(ctx.localIndex["img.png"].plainHash).toBe(rawMd5(binA));
        expect(ctx.index["img.png"].plainHash).toBe(rawMd5(binA));
        expect(ctx.localIndex["sjis.txt"].plainHash).toBe(rawMd5(sjisA));
        expect(ctx.localIndex["note.md"].plainHash).toBe(oldHash(enc("a\r\n"))); // text: unchanged
        expect(plainHashVersion(ctx)).toBe(PLAIN_HASH_VERSION);

        // A later edit that only touches an invalid byte is now seen
        ctx.files.set("img.png", binB);
        expect(await hashContent(binB)).not.toBe(ctx.localIndex["img.png"].plainHash);

        // Second run is a no-op (no reads)
        (ctx.vault.readBinary as any).mockClear();
        expect(await migratePlainHashes(ctx)).toBe(-1);
        expect(ctx.vault.readBinary).not.toHaveBeenCalled();
    });

    it("leaves files changed since the last sync, missing files and foreign remote hashes alone", async () => {
        const ctx = makeCtx({ "img.png": binA });
        restorePlainHashVersion(ctx, 1, false);
        ctx.localIndex = {
            "img.png": entry(oldHash(buf([0x00, 0x01]))), // content changed since
            "gone.png": entry(oldHash(binB)),
        };
        ctx.index = { "img.png": entry("someone-elses") };
        expect(await migratePlainHashes(ctx)).toBe(0);
        expect(ctx.localIndex["img.png"].plainHash).toBe(oldHash(buf([0x00, 0x01])));
        expect(ctx.localIndex["gone.png"].plainHash).toBe(oldHash(binB));
        expect(ctx.index["img.png"].plainHash).toBe("someone-elses");
    });

    it("waits until the add-on is active", async () => {
        const ctx = makeCtx({ "img.png": binA }, { e2eeEnabled: false });
        restorePlainHashVersion(ctx, undefined, false);
        ctx.localIndex = { "img.png": entry(oldHash(binA)) };
        expect(await migratePlainHashes(ctx)).toBe(-1);
        expect(plainHashVersion(ctx)).toBe(1);
        ctx.e2eeEnabled = true;
        expect(await migratePlainHashes(ctx)).toBe(1);
    });
});

describe("plain hash version persistence", () => {
    it("an old local index is v1, a saved one keeps its version, a new device starts current", async () => {
        const old = makeCtx({ [LOCAL]: enc(JSON.stringify({ index: {}, deviceId: "dev_A" })) });
        await loadLocalIndex(old);
        expect(plainHashVersion(old)).toBe(1);

        await migratePlainHashes(old);
        await saveLocalIndex(old, true);
        const reloaded = makeCtx({ [LOCAL]: old.files.get(LOCAL)! });
        await loadLocalIndex(reloaded);
        expect(plainHashVersion(reloaded)).toBe(PLAIN_HASH_VERSION);

        const fresh = makeCtx({});
        await loadLocalIndex(fresh);
        expect(plainHashVersion(fresh)).toBe(PLAIN_HASH_VERSION);
    });
});
