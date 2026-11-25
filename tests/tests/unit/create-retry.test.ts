/**
 * @file 新規作成リクエストの再送（Google Drive）
 *
 * @description
 * ファイル・フォルダの新規作成（POST）は冪等でない。Drive が処理を完了した後に 5xx を返す場合や、
 * 応答が通信途中で消失する場合に同一リクエストを再送すると、同名の項目が二重に作成される。
 * formal/tla/CloudRetry.tla の反例（Mode = "blind"）を実装上で再現し、修正後の動作を検証する。
 * 擬似 Drive は作成要求を記録し、筋書き通りに「処理済み＋5xx」「処理済み＋応答消失」などを返す。
 *
 * @pass_criteria
 * - 処理済みの後に 5xx または応答消失: 項目は 1 件のみ、結果はその項目
 * - 未処理で 5xx: 再送して 1 件作成
 * - 同時に他端末が同名の項目を作成: 自端末の項目を結果とし、他端末の項目を取り違えない
 * - フォルダ作成も同様に 1 件のみ
 * - ブラウザ（Chromium）が同一の作成要求を自動再送: 事前予約 ID により二度目は 409 で拒否され、
 *   項目は 1 件のみ、結果はその項目（予約 ID を取得できない場合は従来どおり ID 指定なし）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleDriveAdapter } from "../../../src/cloud-adapters/google-drive";
import { windowStub } from "../../setup-window";

type Outcome = "ok" | "applied-503" | "applied-lost" | "rejected-503" | "applied-resent";
interface Item { id: string; name: string; by: "me" | "other"; marker?: string; md5: string }

function response(body: unknown, status = 200): Response {
    const text = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(text),
    } as unknown as Response;
}

/** Drive that answers each create request with the next scripted outcome */
function fakeDrive(outcomes: Outcome[], onCreate?: () => void, reserveIds = false) {
    const items: Item[] = [];
    let next = 1;
    let reserved = 1;
    const metadataOf = (init: RequestInit): any => {
        const raw = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array);
        const json = raw.startsWith("{") ? raw : raw.split("\r\n\r\n")[1].split("\r\n--")[0];
        return JSON.parse(json);
    };
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === "POST") {
            onCreate?.();
            const outcome = outcomes.shift() ?? "ok";
            const meta = metadataOf(init);
            let item: Item | undefined;
            const create = (): Response | null => {
                if (meta.id && items.some((i) => i.id === meta.id)) {
                    return response({ error: { message: "A file already exists with the provided ID." } }, 409);
                }
                item = { id: meta.id ?? `id-${next++}`, name: meta.name, by: "me", marker: meta.appProperties?.vsCreate, md5: "m" };
                items.push(item);
                return null;
            };
            if (outcome !== "rejected-503") create();
            // The browser lost the answer and sent the same request again by itself:
            // the page sees only the answer to that second request
            if (outcome === "applied-resent") return create() ?? response({ id: item!.id, md5Checksum: item!.md5, size: "1" });
            if (outcome === "applied-lost") throw new TypeError("Failed to fetch");
            if (outcome !== "ok") return response({ error: { message: "backendError" } }, 503);
            return response({ id: item!.id, md5Checksum: item!.md5, size: "1" });
        }
        if (reserveIds && url.includes("/files/generateIds")) {
            return response({ ids: [`gen-${reserved++}`, `gen-${reserved++}`] });
        }
        const byId = /\/files\/(gen-\d+)\?/.exec(url)?.[1];
        if (byId) {
            const it = items.find((i) => i.id === byId);
            return it ? response({ id: it.id, md5Checksum: it.md5, size: "1" }) : response({ error: { message: "notFound" } }, 404);
        }
        const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? "");
        const marker = /value='([^']+)'/.exec(q)?.[1];
        if (marker) {
            return response({ files: items.filter((i) => i.marker === marker).map((i) => ({ id: i.id, md5Checksum: i.md5, size: "1" })) });
        }
        throw new Error(`Unexpected fetch ${init.method ?? "GET"} ${url}`);
    });
    const otherCreates = (name: string) => items.push({ id: `other-${next++}`, name, by: "other", md5: "o" });
    return { items, fetch, otherCreates };
}

function createAdapter(): GoogleDriveAdapter {
    const adapter = new GoogleDriveAdapter("cid", "csec", "test-vault");
    adapter.setTokens("valid-token", "valid-refresh-token", Date.now() + 3600_000);
    adapter.setLogger(() => {});
    const resolver = (adapter as any).pathResolver;
    resolver.resolveParentId = async () => "parent-id";
    adapter.getFileMetadata = async () => null;
    return adapter;
}

describe("Create requests are not carried out twice", () => {
    beforeEach(() => {
        vi.stubGlobal("window", windowStub({ navigator: { onLine: true }, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
        // Back-off waits run at once (the 90 s request timeout is left alone)
        const realSetTimeout = globalThis.setTimeout;
        vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) =>
            realSetTimeout(fn, ms !== undefined && ms < 60_000 ? 0 : ms)) as typeof setTimeout);
    });
    afterEach(() => vi.unstubAllGlobals());

    const upload = (adapter: GoogleDriveAdapter) => adapter.uploadFile("notes/a.md", new TextEncoder().encode("x").buffer as ArrayBuffer, 1);

    it("leaves one file when Drive created it but answered 503", async () => {
        const drive = fakeDrive(["applied-503", "ok"]);
        vi.stubGlobal("fetch", drive.fetch);
        const result = await upload(createAdapter());
        expect(drive.items).toHaveLength(1);
        expect(result.id).toBe(drive.items[0].id);
    });

    it("leaves one file when Drive created it but the answer was lost", async () => {
        const drive = fakeDrive(["applied-lost", "ok"]);
        vi.stubGlobal("fetch", drive.fetch);
        const result = await upload(createAdapter());
        expect(drive.items).toHaveLength(1);
        expect(result.id).toBe(drive.items[0].id);
    });

    it("sends the request again when Drive did not carry it out", async () => {
        const drive = fakeDrive(["rejected-503", "ok"]);
        vi.stubGlobal("fetch", drive.fetch);
        const result = await upload(createAdapter());
        expect(drive.items).toHaveLength(1);
        expect(result.id).toBe(drive.items[0].id);
    });

    it("never takes another device's file of the same name for its own", async () => {
        const drive = fakeDrive(["rejected-503", "ok"]);
        drive.otherCreates("a.md");
        vi.stubGlobal("fetch", drive.fetch);
        const result = await upload(createAdapter());
        const mine = drive.items.filter((i) => i.by === "me");
        expect(mine).toHaveLength(1);
        expect(result.id).toBe(mine[0].id);
    });

    it("leaves one folder when Drive created it but answered 503", async () => {
        const drive = fakeDrive(["applied-503", "ok"]);
        vi.stubGlobal("fetch", drive.fetch);
        const id = await createAdapter().createFolder("notes", "parent-id");
        expect(drive.items).toHaveLength(1);
        expect(id).toBe(drive.items[0].id);
    });

    it("leaves one file when the browser sent the create again by itself", async () => {
        const drive = fakeDrive(["applied-resent"], undefined, true);
        vi.stubGlobal("fetch", drive.fetch);
        const result = await upload(createAdapter());
        expect(drive.items).toHaveLength(1);
        expect(result.id).toBe(drive.items[0].id);
        expect(result.id).toMatch(/^gen-/);
    });

    it("leaves one folder when the browser sent the create again by itself", async () => {
        const drive = fakeDrive(["applied-resent"], undefined, true);
        vi.stubGlobal("fetch", drive.fetch);
        const id = await createAdapter().createFolder("notes", "parent-id");
        expect(drive.items).toHaveLength(1);
        expect(id).toBe(drive.items[0].id);
    });

    it("still leaves one file after a lost answer when ids are reserved", async () => {
        const drive = fakeDrive(["applied-lost", "ok"], undefined, true);
        vi.stubGlobal("fetch", drive.fetch);
        const result = await upload(createAdapter());
        expect(drive.items).toHaveLength(1);
        expect(result.id).toBe(drive.items[0].id);
    });

    it("gives up after the retry limit", async () => {
        const drive = fakeDrive(["rejected-503", "rejected-503", "rejected-503", "rejected-503", "ok"]);
        vi.stubGlobal("fetch", drive.fetch);
        await expect(upload(createAdapter())).rejects.toThrow();
        expect(drive.items).toHaveLength(0);
    });
});
