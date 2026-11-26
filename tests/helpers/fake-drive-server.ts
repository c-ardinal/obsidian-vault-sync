import { md5 } from "../../src/utils/md5";
import { GoogleDriveAdapter } from "../../src/cloud-adapters/google-drive/index";

const FOLDER = "application/vnd.google-apps.folder";

interface DriveItem {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    modifiedTime: string;
    content?: Uint8Array;
    md5Checksum?: string;
    appProperties?: Record<string, string>;
    revisions: { id: string; modifiedTime: string; content: Uint8Array; md5Checksum: string; keepForever: boolean }[];
}

interface UploadSession {
    fileId?: string;
    metadata: { name?: string; parents?: string[]; modifiedTime?: string; appProperties?: Record<string, string> };
    total: number;
    received: Uint8Array[];
    receivedBytes: number;
    /** Set once every byte arrived: Drive answers later status queries with the file */
    doneId?: string;
}

/**
 * In-memory stand-in for the parts of the Google Drive v3 REST API the adapter
 * calls. It answers at the fetch level, so the real adapter, path resolver and
 * HTTP client (status handling, CloudError mapping) run unchanged.
 */
export class FakeDriveServer {
    private items = new Map<string, DriveItem>();
    private changeLog: string[] = [];
    private sessions = new Map<string, UploadSession>();
    private nextId = 1;
    /** Entries per changes.list page; Drive pages with nextPageToken */
    changesPageSize = 1000;
    /** Every request seen, as "METHOD path" (for debugging failed contract cases) */
    readonly requests: string[] = [];

    /**
     * The vault as Drive holds it: path (relative to the vault folder) -> item.
     * Folders end in "/". Several items of one path (duplicates) get " #2", " #3"...
     */
    vaultItems(vaultName = "ContractVault"): Map<string, { folder: boolean; content?: Uint8Array }> {
        const all = [...this.items.values()];
        const vault = all.find((i) => i.name === vaultName && i.mimeType === FOLDER);
        const out = new Map<string, { folder: boolean; content?: Uint8Array }>();
        if (!vault) return out;
        const walk = (parentId: string, prefix: string) => {
            for (const it of all.filter((x) => x.parents.includes(parentId))) {
                const folder = it.mimeType === FOLDER;
                let key = prefix + it.name + (folder ? "/" : "");
                for (let n = 2; out.has(key); n++) key = `${prefix}${it.name} #${n}${folder ? "/" : ""}`;
                out.set(key, { folder, content: it.content });
                if (folder) walk(it.id, prefix + it.name + "/");
            }
        };
        walk(vault.id, "");
        return out;
    }

    /** A fetch() replacement: (url, init) -> Response */
    readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const method = (init.method || "GET").toUpperCase();
        const u = new URL(url);
        this.requests.push(`${method} ${u.pathname}`);
        return this.route(method, u, init);
    };

    private newId(prefix = "drv"): string {
        return `${prefix}_${this.nextId++}`;
    }

    private record(id: string): void {
        this.changeLog.push(id);
    }

    private json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
        return new Response(JSON.stringify(data), {
            status,
            headers: { "Content-Type": "application/json", ...headers },
        });
    }

    private error(status: number, message: string): Response {
        return this.json({ error: { code: status, message } }, status);
    }

    private meta(item: DriveItem) {
        return {
            id: item.id,
            name: item.name,
            mimeType: item.mimeType,
            parents: item.parents,
            modifiedTime: item.modifiedTime,
            trashed: false,
            ...(item.content ? { size: String(item.content.byteLength), md5Checksum: item.md5Checksum } : {}),
        };
    }

    private writeContent(item: DriveItem, bytes: Uint8Array, modifiedTime?: string): void {
        item.content = bytes.slice();
        item.md5Checksum = md5(bytes.slice().buffer);
        item.modifiedTime = modifiedTime || new Date().toISOString();
        item.revisions.push({
            id: this.newId("rev"),
            modifiedTime: item.modifiedTime,
            content: item.content,
            md5Checksum: item.md5Checksum,
            keepForever: false,
        });
        this.record(item.id);
    }

    /** Like Drive: an id reserved with generateIds can be given once; again it is refused (409) */
    private idTaken(meta: { id?: unknown }): Response | null {
        if (typeof meta.id === "string" && this.items.has(meta.id)) {
            return this.error(409, `A file already exists with the provided ID.`);
        }
        return null;
    }

    private createItem(meta: {
        id?: string;
        name?: string;
        mimeType?: string;
        parents?: string[];
        modifiedTime?: string;
        appProperties?: Record<string, string>;
    }): DriveItem {
        const item: DriveItem = {
            id: typeof meta.id === "string" ? meta.id : this.newId(),
            name: meta.name || "untitled",
            mimeType: meta.mimeType || "application/octet-stream",
            parents: meta.parents || ["root"],
            modifiedTime: meta.modifiedTime || new Date().toISOString(),
            revisions: [],
            ...(meta.appProperties ? { appProperties: { ...meta.appProperties } } : {}),
        };
        this.items.set(item.id, item);
        return item;
    }

    private remove(id: string): void {
        for (const child of [...this.items.values()]) {
            if (child.parents.includes(id)) this.remove(child.id);
        }
        this.items.delete(id);
        this.record(id);
    }

    /** Evaluate the subset of Drive's query language the adapter uses */
    private matches(item: DriveItem, q: string): boolean {
        // "appProperties has { key='k' and value='v' }" holds an "and" of its own
        const q1 = q.replace(
            /appProperties has \{ key=('(?:[^'\\]|\\.)*') and value=('(?:[^'\\]|\\.)*') \}/g,
            "appProperty $1 = $2",
        );
        const clauses = q1.split(/\s+and\s+(?=(?:[^']*'[^']*')*[^']*$)/);
        const unquote = (s: string) => s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        for (const raw of clauses) {
            const c = raw.trim();
            let m: RegExpExecArray | null;
            if ((m = /^name = ('(?:[^'\\]|\\.)*')$/.exec(c))) {
                if (item.name !== unquote(m[1])) return false;
            } else if ((m = /^('(?:[^'\\]|\\.)*') in parents$/.exec(c))) {
                if (!item.parents.includes(unquote(m[1]))) return false;
            } else if ((m = /^mimeType = ('(?:[^'\\]|\\.)*')$/.exec(c))) {
                if (item.mimeType !== unquote(m[1])) return false;
            } else if ((m = /^appProperty ('(?:[^'\\]|\\.)*') = ('(?:[^'\\]|\\.)*')$/.exec(c))) {
                if (item.appProperties?.[unquote(m[1])] !== unquote(m[2])) return false;
            } else if (c === "trashed = false") {
                // deleted items are gone from the store, nothing is trashed
            } else {
                throw new Error(`FakeDriveServer: unsupported query clause: ${c}`);
            }
        }
        return true;
    }

    private async bodyBytes(init: RequestInit): Promise<Uint8Array> {
        const b = init.body;
        if (!b) return new Uint8Array();
        if (typeof b === "string") return new TextEncoder().encode(b);
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        throw new Error("FakeDriveServer: unsupported body type");
    }

    private header(init: RequestInit, name: string): string | null {
        return new Headers(init.headers || {}).get(name);
    }

    /** Split a multipart/related upload into its JSON metadata and its bytes */
    private parseMultipart(
        body: Uint8Array,
        contentType: string,
    ): { meta: Record<string, unknown>; bytes: Uint8Array } {
        const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
        if (!boundary) throw new Error("FakeDriveServer: multipart without boundary");
        const find = (needle: string, from: number) => {
            const n = new TextEncoder().encode(needle);
            outer: for (let i = from; i <= body.length - n.length; i++) {
                for (let j = 0; j < n.length; j++) if (body[i + j] !== n[j]) continue outer;
                return i;
            }
            return -1;
        };
        const metaStart = find("\r\n\r\n", 0) + 4;
        const metaEnd = find(`\r\n--${boundary}`, metaStart);
        const meta = JSON.parse(new TextDecoder().decode(body.slice(metaStart, metaEnd))) as Record<string, unknown>;
        const dataStart = find("\r\n\r\n", metaEnd) + 4;
        const dataEnd = find(`\r\n--${boundary}--`, dataStart);
        return { meta, bytes: body.slice(dataStart, dataEnd) };
    }

    private async route(method: string, u: URL, init: RequestInit): Promise<Response> {
        const p = u.pathname;
        const qs = u.searchParams;

        // --- Resumable session chunks ---
        let m = /^\/upload-session\/(\w+)$/.exec(p);
        if (m && method === "PUT") return this.putChunk(m[1], init);

        // --- Uploads ---
        m = /^\/upload\/drive\/v3\/files(?:\/([\w-]+))?$/.exec(p);
        if (m) {
            const fileId = m[1];
            if (fileId && !this.items.has(fileId)) return this.error(404, `File not found: ${fileId}.`);
            if (qs.get("uploadType") === "multipart") {
                const { meta, bytes } = this.parseMultipart(
                    await this.bodyBytes(init),
                    this.header(init, "Content-Type") || "",
                );
                const taken = fileId ? null : this.idTaken(meta);
                if (taken) return taken;
                const item = fileId ? this.items.get(fileId)! : this.createItem(meta);
                if (fileId && typeof meta.name === "string") item.name = meta.name;
                this.writeContent(item, bytes, meta.modifiedTime as string | undefined);
                return this.json(this.meta(item));
            }
            if (qs.get("uploadType") === "resumable") {
                const sid = this.newId("s");
                this.sessions.set(sid, {
                    fileId,
                    metadata: JSON.parse(new TextDecoder().decode(await this.bodyBytes(init))),
                    total: Number(this.header(init, "X-Upload-Content-Length")),
                    received: [],
                    receivedBytes: 0,
                });
                return this.json({}, 200, { Location: `https://fake-drive.test/upload-session/${sid}` });
            }
        }

        if (p === "/drive/v3/about") {
            return this.json({ storageQuota: { limit: String(15 * 1024 ** 3), usage: "0", usageInDriveTrash: "0" } });
        }

        // --- Change feed ---
        if (p === "/drive/v3/changes/startPageToken") {
            return this.json({ startPageToken: String(this.changeLog.length) });
        }
        if (p === "/drive/v3/changes") return this.listChanges(qs);

        // --- Revisions ---
        m = /^\/drive\/v3\/files\/([\w-]+)\/revisions(?:\/([\w-]+))?$/.exec(p);
        if (m) return this.revisions(method, m[1], m[2], qs, init);

        // --- Server-side copy ---
        m = /^\/drive\/v3\/files\/([\w-]+)\/copy$/.exec(p);
        if (m && method === "POST") {
            const src = this.items.get(m[1]);
            if (!src) return this.error(404, `File not found: ${m[1]}.`);
            const meta = JSON.parse(new TextDecoder().decode(await this.bodyBytes(init))) as {
                id?: string;
                name?: string;
                parents?: string[];
                appProperties?: Record<string, string>;
            };
            const taken = this.idTaken(meta);
            if (taken) return taken;
            const item = this.createItem({
                id: meta.id,
                appProperties: meta.appProperties,
                name: meta.name ?? src.name,
                mimeType: src.mimeType,
                parents: meta.parents ?? src.parents,
                modifiedTime: src.modifiedTime,
            });
            if (src.content) this.writeContent(item, src.content.slice(), src.modifiedTime);
            return this.json(this.meta(item));
        }

        // --- Reserved ids ---
        if (p === "/drive/v3/files/generateIds") {
            const count = Number(qs.get("count") || "10");
            return this.json({ ids: Array.from({ length: count }, () => this.newId("gen")) });
        }

        // --- Files ---
        if (p === "/drive/v3/files") {
            if (method === "POST") {
                const meta = JSON.parse(new TextDecoder().decode(await this.bodyBytes(init)));
                const taken = this.idTaken(meta);
                if (taken) return taken;
                const item = this.createItem(meta);
                this.record(item.id);
                return this.json({ id: item.id });
            }
            const q = qs.get("q") || "";
            const files = [...this.items.values()].filter((i) => this.matches(i, q)).map((i) => this.meta(i));
            return this.json({ files });
        }
        m = /^\/drive\/v3\/files\/([\w-]+)$/.exec(p);
        // "root" names My Drive, which has no parents
        if (m?.[1] === "root" && method === "GET" && !this.items.has("root")) {
            return this.json({ id: "root", name: "My Drive", mimeType: "application/vnd.google-apps.folder" });
        }
        if (m) {
            const item = this.items.get(m[1]);
            if (!item) return this.error(404, `File not found: ${m[1]}.`);
            if (method === "DELETE") {
                this.remove(item.id);
                return new Response(null, { status: 204 });
            }
            if (method === "PATCH") {
                const add = qs.get("addParents");
                const rem = qs.get("removeParents");
                if (rem) item.parents = item.parents.filter((x) => x !== rem);
                if (add && !item.parents.includes(add)) item.parents.push(add);
                const bytes = await this.bodyBytes(init);
                if (bytes.length) {
                    const meta = JSON.parse(new TextDecoder().decode(bytes)) as { name?: string };
                    if (meta.name) item.name = meta.name;
                }
                this.record(item.id);
                return this.json(this.meta(item));
            }
            if (qs.get("alt") === "media") {
                return new Response(item.content ? item.content.slice() : new Uint8Array(), { status: 200 });
            }
            return this.json(this.meta(item));
        }

        throw new Error(`FakeDriveServer: unhandled ${method} ${p}`);
    }

    private async putChunk(sid: string, init: RequestInit): Promise<Response> {
        const s = this.sessions.get(sid);
        if (!s) return this.error(404, "Upload session not found");
        if (s.doneId) {
            const done = this.items.get(s.doneId);
            return done ? this.json(this.meta(done)) : this.error(404, "File not found");
        }
        const range = this.header(init, "Content-Range") || "";
        if (!/^bytes \*\//.test(range)) {
            const start = Number(/^bytes (\d+)-/.exec(range)?.[1]);
            const chunk = await this.bodyBytes(init);
            // A chunk sent again (its answer was lost; browsers also resend a request
            // on their own when a reused connection drops): the bytes Drive already
            // has are skipped. A gap is an error.
            if (start > s.receivedBytes || start + chunk.byteLength < s.receivedBytes) {
                return this.error(400, `Unexpected offset ${start}`);
            }
            const fresh = chunk.slice(s.receivedBytes - start);
            s.received.push(fresh);
            s.receivedBytes += fresh.byteLength;
        }
        if (s.receivedBytes < s.total) {
            const headers: Record<string, string> =
                s.receivedBytes > 0 ? { Range: `bytes=0-${s.receivedBytes - 1}` } : {};
            return new Response(null, { status: 308, headers });
        }
        const all = new Uint8Array(s.total);
        let pos = 0;
        for (const c of s.received) {
            all.set(c, pos);
            pos += c.byteLength;
        }
        const item = s.fileId ? this.items.get(s.fileId) : this.createItem(s.metadata);
        if (!item) return this.error(404, "File not found");
        s.doneId = item.id;
        s.received = [];
        if (s.fileId && s.metadata.name) item.name = s.metadata.name;
        this.writeContent(item, all, s.metadata.modifiedTime);
        return this.json(this.meta(item));
    }

    /** Like Drive: each file once, at its latest change, with its current state */
    private listChanges(qs: URLSearchParams): Response {
        const from = Number(qs.get("pageToken")) || 0;
        const to = Math.min(this.changeLog.length, from + this.changesPageSize);
        const last = new Map<string, number>();
        this.changeLog.forEach((id, i) => last.set(id, i));
        const changes = [];
        for (let i = from; i < to; i++) {
            const id = this.changeLog[i];
            if (last.get(id) !== i) continue;
            const item = this.items.get(id);
            changes.push(item ? { fileId: id, removed: false, file: this.meta(item) } : { fileId: id, removed: true });
        }
        return this.json(
            to < this.changeLog.length
                ? { nextPageToken: String(to), changes }
                : { newStartPageToken: String(this.changeLog.length), changes },
        );
    }

    private async revisions(
        method: string,
        fileId: string,
        revId: string | undefined,
        qs: URLSearchParams,
        init: RequestInit,
    ): Promise<Response> {
        const item = this.items.get(fileId);
        if (!item) return this.error(404, `File not found: ${fileId}.`);
        if (!revId) {
            return this.json({
                revisions: item.revisions.map((r) => ({
                    id: r.id,
                    modifiedTime: r.modifiedTime,
                    size: String(r.content.byteLength),
                    md5Checksum: r.md5Checksum,
                    keepForever: r.keepForever,
                })),
            });
        }
        const rev = item.revisions.find((r) => r.id === revId);
        if (!rev) return this.error(404, `Revision not found: ${revId}.`);
        if (method === "DELETE") {
            item.revisions = item.revisions.filter((r) => r !== rev);
            return new Response(null, { status: 204 });
        }
        if (method === "PATCH") {
            const body = JSON.parse(new TextDecoder().decode(await this.bodyBytes(init))) as { keepForever?: boolean };
            if (typeof body.keepForever === "boolean") rev.keepForever = body.keepForever;
            return this.json({ id: rev.id, keepForever: rev.keepForever });
        }
        if (qs.get("alt") === "media") return new Response(rev.content.slice(), { status: 200 });
        return this.json({ id: rev.id, md5Checksum: rev.md5Checksum });
    }
}

/** A real GoogleDriveAdapter whose HTTP traffic goes to a FakeDriveServer */
export function driveAdapterOnFakeServer(server = new FakeDriveServer()): {
    adapter: GoogleDriveAdapter;
    server: FakeDriveServer;
} {
    const adapter = new GoogleDriveAdapter("test-client-id", "test-secret", "ContractVault", "ContractRoot");
    adapter.auth.accessToken = "fake-access-token";
    adapter.auth.refreshToken = "fake-refresh-token";
    adapter.auth.tokenExpiresAt = Date.now() + 3600 * 1000;
    (adapter as unknown as { http: { limitedFetch: FakeDriveServer["fetch"] } }).http.limitedFetch = server.fetch;
    return { adapter, server };
}
