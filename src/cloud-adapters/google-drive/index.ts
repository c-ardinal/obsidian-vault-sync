import { CloudAdapter, CloudCapabilities, CloudChanges, CloudFile } from "../../types/adapter";
import type { OAuthCloudAdapter } from "../../types/oauth-adapter";
import { basename } from "../../utils/path";
import { CloudError, isCloudNotFound } from "../cloud-error";
import { GoogleAuthService, type AuthMethod } from "./auth-service";
import { GoogleDriveHttpClient } from "./http-client";
import { DrivePathResolver, isUnreachableFromVault } from "./path-resolver";

export type { AuthMethod };

/** Subset of a Drive v3 `File` resource as returned for the `fields` we request */
interface DriveFile {
    id: string;
    name: string;
    mimeType?: string;
    modifiedTime: string;
    size?: string;
    md5Checksum?: string;
    trashed?: boolean;
    parents?: string[];
}

interface DriveFileList {
    files?: DriveFile[];
    nextPageToken?: string;
}

interface DriveChange {
    fileId: string;
    removed: boolean;
    file?: DriveFile;
}

interface DriveChangeList {
    nextPageToken?: string;
    newStartPageToken?: string;
    changes?: DriveChange[];
}

interface DriveRevision {
    id: string;
    modifiedTime: string;
    size?: string;
    lastModifyingUser?: { displayName?: string };
    keepForever?: boolean;
    md5Checksum?: string;
}

interface DriveUploadMetadata {
    name: string;
    modifiedTime?: string;
    parents?: string[];
}

/** Every resumable upload chunk but the last must be a multiple of this (Drive API rule) */
export const DRIVE_RESUMABLE_ALIGNMENT = 256 * 1024;

export const GOOGLE_DRIVE_CAPABILITIES: CloudCapabilities = Object.freeze({
    changeFeed: true,
    revisions: true,
    contentHash: "md5", // md5Checksum of the stored bytes
    stableIds: true,
    sameNameSiblings: true, // a folder may hold several files with one name
    resumableChunkAlignment: DRIVE_RESUMABLE_ALIGNMENT,
    trash: false, // Drive has a trash, but this adapter does not use it yet
    conditionalWrite: false, // Drive offers no compare-and-set on content
});

export class GoogleDriveAdapter implements OAuthCloudAdapter {
    name = "Google Drive";

    // Feature flags - Google Drive supports both
    readonly capabilities: CloudCapabilities = GOOGLE_DRIVE_CAPABILITIES;

    public auth: GoogleAuthService;
    private http: GoogleDriveHttpClient;
    private pathResolver: DrivePathResolver;

    constructor(
        clientId: string,
        clientSecret: string,
        public vaultName: string,
        cloudRootFolder?: string,
    ) {
        this.auth = new GoogleAuthService(clientId, clientSecret);
        this.http = new GoogleDriveHttpClient(this.auth);
        this.pathResolver = new DrivePathResolver(this.http, vaultName, cloudRootFolder || "");
    }

    get clientId(): string {
        return this.auth.clientId;
    }

    get clientSecret(): string {
        return this.auth.clientSecret;
    }

    get rootFolder(): string {
        return this.pathResolver.rootFolder;
    }

    setCredentials(clientId: string, clientSecret: string) {
        this.auth.setCredentials(clientId, clientSecret);
    }

    private logger: ((msg: string, level?: string) => void) | null = null;
    setLogger(logger: (msg: string, level?: string) => void) {
        this.logger = logger;
        this.auth.setLogger(logger);
        this.pathResolver.setLogger(logger);
    }

    // Callback for fatal auth errors (e.g. invalid grant) — delegated to auth
    set onAuthFailure(cb: (() => void | Promise<void>) | null) {
        this.auth.onAuthFailure = cb;
    }
    get onAuthFailure(): (() => void | Promise<void>) | null {
        return this.auth.onAuthFailure;
    }
    // Callback after successful token refresh (to persist new tokens) — delegated to auth
    set onTokenRefresh(cb: (() => void | Promise<void>) | null) {
        this.auth.onTokenRefresh = cb;
    }
    get onTokenRefresh(): (() => void | Promise<void>) | null {
        return this.auth.onTokenRefresh;
    }

    updateConfig(
        clientId: string,
        clientSecret: string,
        vaultName?: string,
        cloudRootFolder?: string,
    ) {
        this.auth.setCredentials(clientId, clientSecret);
        this.pathResolver.updateConfig(vaultName, cloudRootFolder);
        if (vaultName) this.vaultName = vaultName;
    }

    // === Auth delegation ===
    setAuthConfig(method: AuthMethod, proxyUrl?: string) {
        this.auth.setAuthConfig(method, proxyUrl);
    }
    isAuthenticated(): boolean {
        return this.auth.isAuthenticated();
    }
    getTokens() {
        return this.auth.getTokens();
    }
    setTokens(accessToken: string | null, refreshToken: string | null, tokenExpiresAt?: number) {
        const hadToken = this.auth.isAuthenticated();
        this.auth.setTokens(accessToken, refreshToken, tokenExpiresAt);
        // Clear cached initPromise when auth state changes so ensureRootFolders
        // re-runs with the new credentials instead of returning a stale rejection.
        if (!hadToken && accessToken) {
            this.pathResolver.clearFolderCaches();
        }
    }
    getAuthStatus(): string {
        return this.auth.getAuthStatus();
    }
    async getAuthUrl(): Promise<string> {
        return this.auth.getAuthUrl();
    }
    verifyState(state: string): boolean {
        return this.auth.verifyState(state);
    }
    async login(): Promise<void> {
        return this.auth.login();
    }
    async exchangeCodeForToken(code: string): Promise<void> {
        return this.auth.exchangeCodeForToken(code);
    }
    async handleCallback(url: string | URL): Promise<void> {
        return this.auth.handleCallback(url);
    }
    async logout(): Promise<void> {
        return this.auth.logout();
    }

    // === Path resolver delegation ===
    async initialize(): Promise<void> {
        await this.pathResolver.initialize();
    }
    async getAppRootId(): Promise<string> {
        return this.pathResolver.getAppRootId();
    }
    reset() {
        this.pathResolver.reset();
    }
    async createFolder(name: string, parentId?: string): Promise<string> {
        return this.pathResolver.createFolder(name, parentId);
    }
    async ensureFoldersExist(
        folderPaths: string[],
        onProgress?: (current: number, total: number, name: string) => void,
    ): Promise<void> {
        return this.pathResolver.ensureFoldersExist(folderPaths, onProgress);
    }
    async getFolderIdByName(name: string, parentId?: string): Promise<string | null> {
        return this.pathResolver.getFolderIdByName(name, parentId);
    }

    cloneWithNewVaultName(newVaultName: string): CloudAdapter {
        const cloned = new GoogleDriveAdapter(
            this.auth.clientId,
            this.auth.clientSecret,
            newVaultName,
            this.rootFolder,
        );
        const tokens = this.auth.getTokens();
        cloned.auth.setTokens(tokens.accessToken, tokens.refreshToken, tokens.tokenExpiresAt);
        if (this.logger) {
            cloned.setLogger(this.logger);
        }
        return cloned;
    }

    getBaseAdapter(): CloudAdapter {
        return this;
    }

    // Keep static constant for backward compatibility with tests
    static readonly ONLINE_TIMEOUT_MS = GoogleDriveHttpClient.ONLINE_TIMEOUT_MS;

    // === File Operations ===

    async getFileMetadata(path: string): Promise<CloudFile | null> {
        try {
            const parentId = await this.pathResolver.resolveParentId(path, false);
            const name = basename(path);
            const query = `name = '${this.http.escapeQueryValue(
                name || "",
            )}' and '${parentId}' in parents and trashed = false`;
            const response = await this.http.fetchWithAuth(
                `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,size,md5Checksum)`,
            );
            const data = (await response.json()) as DriveFileList;

            if (data.files && data.files.length > 0) {
                const file = data.files[0];
                return {
                    id: file.id,
                    path: path,
                    mtime: new Date(file.modifiedTime).getTime(),
                    size: parseInt(file.size || "0"),
                    kind:
                        file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
                    hash: file.md5Checksum,
                };
            }
            return null;
        } catch (e) {
            // A missing parent folder means the file does not exist. Anything else
            // (network, 429/5xx after retries, auth) is NOT "not found": callers that
            // got null used to upload without their conflict check (overwriting another
            // device's version) or create a second file with the same name.
            if (isNotFound(e)) return null;
            throw e;
        }
    }

    async getFileMetadataById(fileId: string, knownPath?: string): Promise<CloudFile | null> {
        let file: DriveFile;
        try {
            // Direct ID lookup provides stronger consistency than query search
            const response = await this.http.fetchWithAuth(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,modifiedTime,size,md5Checksum,trashed,parents`,
            );
            file = (await response.json()) as DriveFile;
        } catch (e) {
            // Only a real 404 means "gone"; transient errors must not look like a deletion
            if (isNotFound(e)) return null;
            throw e;
        }

        // Handle deleted/trashed files as null
        if (!file.id || file.trashed) return null;

        // Report the CURRENT path. Echoing knownPath back hid renames made by other
        // devices from every caller that compares paths.
        let path = knownPath || file.name;
        if (knownPath && basename(knownPath) !== file.name) {
            path = file.name;
            if (file.parents?.[0]) {
                try {
                    const parentPath = await this.pathResolver.resolveFullPath(file.parents[0]);
                    path = parentPath ? `${parentPath}/${file.name}` : file.name;
                } catch {
                    /* keep the bare name: still signals the rename */
                }
            }
        }

        return {
            id: file.id,
            path,
            mtime: new Date(file.modifiedTime).getTime(),
            size: parseInt(file.size || "0"),
            kind: file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
            hash: file.md5Checksum,
        };
    }

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        const response = await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        );
        return await response.arrayBuffer();
    }

    async uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
        opts?: { createOnly?: boolean },
    ): Promise<CloudFile> {
        const name = basename(path);
        const metadata: DriveUploadMetadata = {
            name: name,
            modifiedTime: new Date(mtime).toISOString(),
        };

        let activeFileId = existingFileId;
        if (!activeFileId && !opts?.createOnly) {
            const existing = await this.getFileMetadata(path);
            if (existing) activeFileId = existing.id;
        }

        let url =
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,md5Checksum,size";
        let method = "POST";

        if (activeFileId) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${activeFileId}?uploadType=multipart&fields=id,md5Checksum,size`;
            method = "PATCH";
        } else {
            const parentId = await this.pathResolver.resolveParentId(path, true);
            metadata.parents = [parentId];
        }

        const boundary = "-------314159265358979323846";
        const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const footer = `\r\n--${boundary}--`;

        const encoder = new TextEncoder();
        const headerArray = encoder.encode(header);
        const footerArray = encoder.encode(footer);

        const bodyArray = new Uint8Array(
            headerArray.byteLength + content.byteLength + footerArray.byteLength,
        );
        bodyArray.set(headerArray, 0);
        bodyArray.set(new Uint8Array(content), headerArray.byteLength);
        bodyArray.set(footerArray, headerArray.byteLength + content.byteLength);

        const response = await this.http.fetchWithAuth(url, {
            method: method,
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body: bodyArray,
        });

        const data = (await response.json()) as DriveFile;
        const result: CloudFile = {
            id: data.id,
            path: path,
            mtime: mtime,
            size: parseInt(data.size || String(content.byteLength)),
            kind: "file",
            hash: data.md5Checksum,
        };

        this.pathResolver.cacheIdToPath(result.id, result.path);
        return result;
    }

    /** Bytes per request of a resumable upload (a multiple of 256 KiB, as Drive requires) */
    static readonly RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
    /** How often one chunk may be resumed after a network error */
    static readonly MAX_CHUNK_RESUMES = 5;

    /**
     * Resumable upload in chunks. A dropped connection only costs the chunk in
     * flight: the server is asked how much it has and the rest is sent. Before,
     * the whole file went in one request and any interruption restarted it.
     */
    async uploadFileResumable(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        if (content.byteLength === 0) return this.uploadFile(path, content, mtime, existingFileId);
        const total = content.byteLength;
        const sessionUri = await this.initiateResumableSession(path, total, mtime, existingFileId);
        const step = GoogleDriveAdapter.RESUMABLE_CHUNK_BYTES;
        for (let offset = 0; offset < total; offset += step) {
            const end = Math.min(offset + step, total);
            const done = await this.uploadChunk(sessionUri, content.slice(offset, end), offset, total, path, mtime);
            if (done) return done;
        }
        // Every byte was acknowledged but the final answer got lost: ask once more
        const status = await this.queryResumableStatus(sessionUri, total, path, mtime);
        if (status.done) return status.done;
        throw new Error(`Resumable upload of ${path} did not complete`);
    }

    async initiateResumableSession(
        path: string,
        totalSize: number,
        mtime: number,
        existingFileId?: string,
    ): Promise<string> {
        const name = basename(path);
        const metadata: DriveUploadMetadata = {
            name: name,
            modifiedTime: new Date(mtime).toISOString(),
        };

        let activeFileId = existingFileId;
        if (!activeFileId) {
            const existing = await this.getFileMetadata(path);
            if (existing) activeFileId = existing.id;
        }

        let initUrl: string;
        let method: string;

        if (activeFileId) {
            initUrl = `https://www.googleapis.com/upload/drive/v3/files/${activeFileId}?uploadType=resumable&fields=id,md5Checksum,size`;
            method = "PATCH";
        } else {
            const parentId = await this.pathResolver.resolveParentId(path, true);
            metadata.parents = [parentId];
            initUrl = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,md5Checksum,size`;
            method = "POST";
        }

        const initResponse = await this.http.fetchWithAuth(initUrl, {
            method,
            headers: {
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": "application/octet-stream",
                "X-Upload-Content-Length": String(totalSize),
            },
            body: JSON.stringify(metadata),
        });

        const sessionUri = initResponse.headers.get("Location");
        if (!sessionUri) {
            throw new Error("Resumable upload: no session URI returned");
        }
        return sessionUri;
    }

    async uploadChunk(
        sessionUri: string,
        chunk: ArrayBuffer,
        offset: number,
        totalSize: number,
        path: string,
        mtime: number,
    ): Promise<CloudFile | null> {
        const end = offset + chunk.byteLength - 1;
        let confirmed = 0; // bytes of this chunk the server already has
        for (let attempt = 0; ; attempt++) {
            const body = confirmed === 0 ? chunk : chunk.slice(confirmed);
            try {
                const uploadResponse = await this.http.fetchWithAuth(
                    sessionUri,
                    {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/octet-stream",
                            "Content-Range": `bytes ${offset + confirmed}-${end}/${totalSize}`,
                        },
                        body,
                    },
                    0,
                    // 308 "Resume Incomplete" is the normal answer to every chunk but the
                    // last; treating it as an error failed every multi-chunk upload.
                    { okStatuses: [308], retryNetworkErrors: false },
                );
                if (uploadResponse.status === 308) return null; // Resume Incomplete
                return this.resumableResult((await uploadResponse.json()) as DriveFile, path, mtime, totalSize);
            } catch (e) {
                if (!(e instanceof TypeError) || attempt >= GoogleDriveAdapter.MAX_CHUNK_RESUMES) throw e;
                await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
                const status = await this.queryResumableStatus(sessionUri, totalSize, path, mtime);
                if (status.done) return status.done;
                const inChunk = status.received - offset;
                if (inChunk < 0) throw e; // the server lost earlier data: start over
                if (inChunk >= chunk.byteLength) return null;
                confirmed = inChunk;
            }
        }
    }

    /**
     * Ask a resumable session how many bytes it has (Content-Range: bytes * /total).
     * `done` is set when the upload already completed.
     */
    async queryResumableStatus(
        sessionUri: string,
        totalSize: number,
        path: string,
        mtime: number,
    ): Promise<{ received: number; done?: CloudFile }> {
        const res = await this.http.fetchWithAuth(
            sessionUri,
            { method: "PUT", headers: { "Content-Range": `bytes */${totalSize}` } },
            0,
            { okStatuses: [308] },
        );
        if (res.status !== 308) {
            return { received: totalSize, done: this.resumableResult((await res.json()) as DriveFile, path, mtime, totalSize) };
        }
        const range = res.headers?.get?.("Range"); // "bytes=0-12345"
        const m = range ? /bytes=0-(\d+)/.exec(range) : null;
        return { received: m ? Number(m[1]) + 1 : 0 };
    }

    private resumableResult(data: DriveFile, path: string, mtime: number, totalSize: number): CloudFile {
        const result: CloudFile = {
            id: data.id,
            path: path,
            mtime: mtime,
            size: parseInt(data.size || String(totalSize)),
            kind: "file",
            hash: data.md5Checksum,
        };
        this.pathResolver.cacheIdToPath(result.id, result.path);
        return result;
    }

    async deleteFile(fileId: string): Promise<void> {
        await this.http.fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: "DELETE",
        });
    }

    async moveFile(
        fileId: string,
        newName: string,
        newParentPath: string | null,
    ): Promise<CloudFile> {
        // 1. 現在のファイルの親フォルダを取得
        const currentMeta = await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,parents,modifiedTime,size,md5Checksum`,
        );
        const currentFile = (await currentMeta.json()) as DriveFile;
        const oldParentId = currentFile.parents?.[0];

        // 2. 新しい親フォルダの ID を解決（パスが変わる場合のみ）
        let newParentId: string | null = null;
        if (newParentPath !== null) {
            newParentId = await this.pathResolver.resolveParentId(
                (newParentPath ? newParentPath + "/" : "") + "__dummy__",
                true,
            );
        }

        // 3. PATCH リクエストを構築
        const queryParams: string[] = [`fields=id,name,mimeType,modifiedTime,size,md5Checksum`];
        if (newParentId && oldParentId && newParentId !== oldParentId) {
            queryParams.push(`addParents=${newParentId}`);
            queryParams.push(`removeParents=${oldParentId}`);
        }

        const metadata: DriveUploadMetadata = { name: newName };
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?${queryParams.join("&")}`;
        const response = await this.http.fetchWithAuth(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(metadata),
        });

        const data = (await response.json()) as DriveFile;

        // 4. 新しいパスを構築
        const parentPath = newParentPath !== null ? newParentPath : "";
        const fullPath = parentPath ? `${parentPath}/${newName}` : newName;

        const result: CloudFile = {
            id: data.id,
            path: fullPath,
            mtime: new Date(data.modifiedTime).getTime(),
            size: parseInt(data.size || "0"),
            kind: data.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
            hash: data.md5Checksum,
        };

        this.pathResolver.cacheIdToPath(result.id, result.path);
        return result;
    }

    async fileExistsById(fileId: string): Promise<boolean> {
        try {
            const response = await this.http.fetchWithAuth(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,trashed`,
            );
            const data = (await response.json()) as Partial<DriveFile>;
            return !!data.id && !data.trashed;
        } catch (e) {
            if (isNotFound(e)) return false;
            throw e;
        }
    }

    // === Changes API ===

    async getStartPageToken(): Promise<string> {
        const response = await this.http.fetchWithAuth(
            "https://www.googleapis.com/drive/v3/changes/startPageToken",
        );
        const data = (await response.json()) as { startPageToken: string };
        return data.startPageToken;
    }

    async getChanges(pageToken: string): Promise<CloudChanges> {
        const fields =
            "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,md5Checksum,parents,trashed))";
        const response = await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/changes?pageToken=${pageToken}&pageSize=1000&fields=${fields}`,
        );
        const data = (await response.json()) as DriveChangeList;

        return {
            nextPageToken: data.nextPageToken,
            newStartPageToken: data.newStartPageToken,
            changes: await Promise.all(
                (data.changes || []).map(async (c: DriveChange): Promise<CloudChanges["changes"][number]> => {
                    let fullPath = c.file ? c.file.name : "";
                    if (c.file && !c.removed && c.file.parents && c.file.parents.length > 0) {
                        try {
                            const parentPath = await this.pathResolver.resolveFullPath(
                                c.file.parents[0],
                            );
                            fullPath = parentPath ? `${parentPath}/${c.file.name}` : c.file.name;
                        } catch (e) {
                            if (!isUnreachableFromVault(e)) {
                                // Transient failure (network, 429/5xx after retries, ...).
                                // Reporting it as "removed" would delete the local file, so
                                // fail the whole page instead: the page token is not
                                // advanced and the change is fetched again next sync.
                                throw e;
                            }
                            // Moved out of the vault, or its folder was deleted / is no
                            // longer accessible: from the vault's point of view it is gone.
                            console.warn(`Failed to resolve parent path for ${c.fileId}:`, e);
                            return { fileId: c.fileId, removed: true };
                        }
                    } else if (c.file && !c.removed) {
                        return { fileId: c.fileId, removed: true };
                    }

                    const isRemoved = c.removed || (c.file && c.file.trashed);

                    return {
                        fileId: c.fileId,
                        removed: isRemoved as boolean,
                        file:
                            c.file && !isRemoved
                                ? {
                                      id: c.file.id,
                                      path: fullPath,
                                      mtime: new Date(c.file.modifiedTime).getTime(),
                                      size: parseInt(c.file.size || "0"),
                                      kind:
                                          c.file.mimeType === "application/vnd.google-apps.folder"
                                              ? "folder"
                                              : "file",
                                      hash: c.file.md5Checksum,
                                  }
                                : undefined,
                    };
                }),
            ),
        };
    }

    async listFiles(folderId?: string): Promise<CloudFile[]> {
        // Clear cached vaultRootId to force fresh lookup (fixes stale pointer bug)
        // QA-003: Memory Leak Fix - Clear caches at start of valid sync session
        this.pathResolver.clearFolderCaches();

        await this.pathResolver.ensureRootFolders();
        const rootId = folderId || this.pathResolver.vaultRootId;
        console.debug(`Vault-Sync: listFiles starting with rootId: ${rootId}`);
        if (!rootId) throw new Error("Vault root not initialized");

        const files: CloudFile[] = [];

        const walk = async (currentFolderId: string, currentPathPrefix: string) => {
            let pageToken: string | undefined = undefined;
            do {
                const query = `'${currentFolderId}' in parents and trashed = false`;
                const url =
                    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum)&pageSize=1000` +
                    (pageToken ? `&pageToken=${pageToken}` : "");

                console.debug(
                    `Vault-Sync: listFiles querying folder ${currentFolderId}, prefix: "${currentPathPrefix}"`,
                );
                const response = await this.http.fetchWithAuth(url);
                const data = (await response.json()) as DriveFileList;
                console.debug(
                    `Vault-Sync: listFiles query returned ${data.files?.length || 0} items`,
                );
                pageToken = data.nextPageToken;

                if (data.files) {
                    for (const file of data.files) {
                        const isFolder = file.mimeType === "application/vnd.google-apps.folder";
                        const relativePath = currentPathPrefix
                            ? `${currentPathPrefix}/${file.name}`
                            : file.name;

                        files.push({
                            id: file.id,
                            path: relativePath,
                            mtime: new Date(file.modifiedTime).getTime(),
                            size: parseInt(file.size || "0"),
                            kind: isFolder ? "folder" : "file",
                            hash: file.md5Checksum,
                        });

                        if (isFolder) {
                            await walk(file.id, relativePath);
                        }
                    }
                }
            } while (pageToken);
        };

        await walk(rootId, "");
        return files;
    }

    // === History & Revisions Support ===

    private validatePath(path: string) {
        if (path.includes("..") || path.includes("\\") || /[<>:"|?*]/.test(path)) {
            throw new Error(`Invalid path: ${path}`);
        }
    }

    async listRevisions(
        path: string,
        fileId?: string,
    ): Promise<import("../../types/adapter").FileRevision[]> {
        this.validatePath(path);
        const meta = fileId ? { id: fileId } : await this.getFileMetadata(path);
        if (!meta) throw new CloudError(`File not found: ${path}`, "not-found");

        const response = await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions?fields=revisions(id,modifiedTime,size,lastModifyingUser,keepForever,md5Checksum)`,
        );
        const data = (await response.json()) as { revisions?: DriveRevision[] };

        return (data.revisions || []).map((rev) => ({
            id: rev.id,
            modifiedTime: new Date(rev.modifiedTime).getTime(),
            size: parseInt(rev.size || "0"),
            author: rev.lastModifyingUser?.displayName,
            keepForever: rev.keepForever,
            hash: rev.md5Checksum,
        }));
    }

    async getRevisionContent(path: string, revisionId: string, fileId?: string): Promise<ArrayBuffer> {
        this.validatePath(path);
        const meta = fileId ? { id: fileId } : await this.getFileMetadata(path);
        if (!meta) throw new CloudError(`File not found: ${path}`, "not-found");

        const metaResponse = await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}?fields=md5Checksum`,
        );
        const metaData = (await metaResponse.json()) as { md5Checksum?: string };
        const expectedHash = metaData.md5Checksum;

        const response = await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}?alt=media`,
        );
        const buffer = await response.arrayBuffer();

        // Security Integrity Check
        if (expectedHash) {
            const { md5 } = await import("../../utils/md5");
            const actualHash = md5(buffer);
            if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
                throw new Error(
                    `[Security] Integrity check failed! Expected ${expectedHash}, got ${actualHash}. Possible data corruption or tampering.`,
                );
            }
        }

        return buffer;
    }

    async setRevisionKeepForever(
        path: string,
        revisionId: string,
        keepForever: boolean,
    ): Promise<void> {
        this.validatePath(path);
        const meta = await this.getFileMetadata(path);
        if (!meta) throw new CloudError(`File not found: ${path}`, "not-found");

        await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keepForever: keepForever }),
            },
        );
    }

    async deleteRevision(path: string, revisionId: string): Promise<void> {
        this.validatePath(path);
        const meta = await this.getFileMetadata(path);
        if (!meta) throw new CloudError(`File not found: ${path}`, "not-found");

        await this.http.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${meta.id}/revisions/${revisionId}`,
            { method: "DELETE" },
        );
    }
}

/** A 404 from Drive, or our own "folder not found" while resolving a parent path */
function isNotFound(e: unknown): boolean {
    return isCloudNotFound(e);
}
