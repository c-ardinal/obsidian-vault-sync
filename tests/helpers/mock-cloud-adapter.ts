import type {
    CloudAdapter,
    CloudCapabilities,
    CloudFile,
    CloudChanges,
    FileRevision,
} from "../../src/types/adapter";
import { md5 } from "../../src/utils/md5";
import { CloudError } from "../../src/cloud-adapters/cloud-error";

interface StoredFile {
    id: string;
    path: string;
    content: ArrayBuffer;
    mtime: number;
    size: number;
    hash: string;
    /** Set by addFakeFolder; everything else is a file */
    kind?: "file" | "folder";
}

interface StoredRevision {
    id: string;
    modifiedTime: number;
    size: number;
    hash: string;
    content: ArrayBuffer;
}

/**
 * In-memory cloud storage simulating Google Drive.
 * Shared between multiple device simulators.
 * Supports file operations, revision history, and change tracking.
 */
export class MockCloudAdapter implements CloudAdapter {
    readonly name = "MockCloud";
    /** Drive-like. Tests may replace it to simulate a cloud that can do less. */
    capabilities: CloudCapabilities = {
        changeFeed: true,
        revisions: true,
        contentHash: "md5",
        stableIds: true,
        sameNameSiblings: true,
        resumableChunkAlignment: 256 * 1024,
        trash: false,
        conditionalWrite: false,
    };
    readonly vaultName = "MockVault";
    /**
     * Max changes returned per getChanges() call. Google Drive pages the
     * Changes API (nextPageToken); Infinity keeps the old single-page behaviour.
     */
    changesPageSize = Infinity;
    /**
     * Google Drive's changes.list reports each file ONCE, at the position of its
     * latest change, with its CURRENT metadata (path, hash) — not one historical
     * snapshot per change. false keeps the old snapshot-per-change behaviour.
     */
    changesLatestStateOnly = false;

    private files = new Map<string, StoredFile>();
    private pathToId = new Map<string, string>();
    /** Revisions keyed by file id, like Drive (they follow the file across renames) */
    private revisions = new Map<string, StoredRevision[]>();
    private nextFileId = 1;
    private nextRevisionId = 1;
    private changeLog: Array<{ fileId: string; removed: boolean; file?: CloudFile }> = [];
    private currentToken = 0;
    private logger: (msg: string) => void = () => {};
    private resumableSessions = new Map<string, {
        path: string; mtime: number; totalSize: number;
        existingFileId?: string; chunks: ArrayBuffer[];
    }>();
    private nextSessionId = 1;
    private errorMap = new Map<string, Error>();

    // --- Auth (no-op) ---
    isAuthenticated(): boolean {
        return true;
    }
    async getAuthUrl(): Promise<string> {
        return "";
    }
    async handleCallback(_url: string | URL): Promise<void> {}
    async logout(): Promise<void> {}

    // --- File Operations ---
    async getFileMetadata(path: string): Promise<CloudFile | null> {
        this.maybeThrow("getFileMetadata");
        const id = this.pathToId.get(path);
        if (!id) return null;
        const file = this.files.get(id);
        if (!file) return null;
        return this.toCloudFile(file);
    }

    async getFileMetadataById(fileId: string, knownPath?: string): Promise<CloudFile | null> {
        const file = this.files.get(fileId);
        if (!file) return null;
        return this.toCloudFile(file);
    }

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        const file = this.files.get(fileId);
        if (!file) throw new CloudError(`Cloud file not found: ${fileId}`, "not-found", 404);
        return file.content.slice(0);
    }

    async uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        targetFileId?: string,
        opts?: { createOnly?: boolean },
    ): Promise<CloudFile> {
        const hash = md5(content);
        // Like Drive: createOnly always makes a new file, even if one has this name
        let id = targetFileId || (opts?.createOnly ? undefined : this.pathToId.get(path));

        if (id && this.files.has(id)) {
            // Update existing file
            const existing = this.files.get(id)!;
            existing.content = content.slice(0);
            existing.mtime = mtime;
            existing.size = content.byteLength;
            existing.hash = hash;

            // Add revision
            this.addRevision(id, content, hash, mtime);

            // Record change
            this.recordChange(id, false, this.toCloudFile(existing));
            return this.toCloudFile(existing);
        } else {
            // Create new file
            id = `file_${this.nextFileId++}`;
            const stored: StoredFile = {
                id,
                path,
                content: content.slice(0),
                mtime,
                size: content.byteLength,
                hash,
            };
            this.files.set(id, stored);
            // A same-name duplicate does not hide the file already found by name
            if (!this.pathToId.has(path)) this.pathToId.set(path, id);

            // Add first revision
            this.addRevision(id, content, hash, mtime);

            this.recordChange(id, false, this.toCloudFile(stored));
            return this.toCloudFile(stored);
        }
    }

    async deleteFile(fileId: string): Promise<void> {
        this.maybeThrow("deleteFile");
        const file = this.files.get(fileId);
        if (file) {
            this.files.delete(fileId);
            this.unmapPath(file.path, fileId);
            this.recordChange(fileId, true);
        }
    }

    async moveFile(
        fileId: string,
        newName: string,
        newParentPath: string | null,
    ): Promise<CloudFile> {
        const file = this.files.get(fileId);
        if (!file) throw new CloudError(`Cloud file not found: ${fileId}`, "not-found", 404);

        const oldPath = file.path;
        // 旧パスからパスマップを削除（同名の重複ファイルがあればそちらを指す）
        file.path = "";
        this.unmapPath(oldPath, fileId);

        // 新パスを構築
        const newPath = newParentPath ? `${newParentPath}/${newName}` : newName;
        file.path = newPath;

        // 新パスでパスマップを登録
        this.pathToId.set(newPath, fileId);

        this.recordChange(fileId, false, this.toCloudFile(file));
        return this.toCloudFile(file);
    }

    /** Drop `path -> fileId`; another file still at `path` (a duplicate) takes its place. */
    private unmapPath(path: string, fileId: string): void {
        if (this.pathToId.get(path) !== fileId) return;
        this.pathToId.delete(path);
        for (const f of this.files.values()) {
            if (f.path === path) {
                this.pathToId.set(path, f.id);
                break;
            }
        }
    }

    async createFolder(_path: string): Promise<string> {
        return `folder_${this.nextFileId++}`;
    }

    async ensureFoldersExist(
        _folderPaths: string[],
        _onProgress?: (current: number, total: number, name: string) => void,
    ): Promise<void> {}

    async fileExistsById(fileId: string): Promise<boolean> {
        return this.files.has(fileId);
    }

    // --- Resumable Chunked Upload ---
    async initiateResumableSession(
        path: string,
        totalSize: number,
        mtime: number,
        existingFileId?: string,
    ): Promise<string> {
        const uri = `mock-session-${this.nextSessionId++}`;
        this.resumableSessions.set(uri, {
            path, mtime, totalSize, existingFileId, chunks: [],
        });
        return uri;
    }

    async uploadChunk(
        sessionUri: string,
        chunk: ArrayBuffer,
        offset: number,
        totalSize: number,
        path: string,
        mtime: number,
    ): Promise<CloudFile | null> {
        const session = this.resumableSessions.get(sessionUri);
        if (!session) throw new Error(`Unknown session: ${sessionUri}`);
        session.chunks.push(chunk.slice(0));

        // Intermediate chunk: more data expected
        if (offset + chunk.byteLength < totalSize) return null;

        // Final chunk: combine all chunks and delegate to uploadFile
        const combined = new Uint8Array(totalSize);
        let pos = 0;
        for (const c of session.chunks) {
            combined.set(new Uint8Array(c), pos);
            pos += c.byteLength;
        }
        this.resumableSessions.delete(sessionUri);
        return this.uploadFile(path, combined.buffer, mtime, session.existingFileId);
    }

    // --- Changes API ---
    async getStartPageToken(): Promise<string> {
        this.maybeThrow("getStartPageToken");
        return String(this.changeLog.length);
    }

    async getChanges(pageToken: string): Promise<CloudChanges> {
        const from = parseInt(pageToken, 10) || 0;
        const to = Math.min(this.changeLog.length, from + this.changesPageSize);
        let changes: CloudChanges["changes"];
        if (this.changesLatestStateOnly) {
            const lastPos = new Map<string, number>();
            this.changeLog.forEach((c, i) => lastPos.set(c.fileId, i));
            changes = [];
            for (let i = from; i < to; i++) {
                const c = this.changeLog[i];
                if (lastPos.get(c.fileId) !== i) continue; // superseded by a later change
                const current = this.files.get(c.fileId);
                changes.push(
                    current
                        ? { fileId: c.fileId, removed: false, file: this.toCloudFile(current) }
                        : { fileId: c.fileId, removed: true },
                );
            }
        } else {
            changes = this.changeLog.slice(from, to).map((c) => ({
                fileId: c.fileId,
                removed: c.removed,
                file: c.file,
            }));
        }
        if (to < this.changeLog.length) {
            return { nextPageToken: String(to), changes };
        }
        return {
            newStartPageToken: String(this.changeLog.length),
            changes,
        };
    }

    async listFiles(_folderId?: string): Promise<CloudFile[]> {
        return Array.from(this.files.values()).map((f) => this.toCloudFile(f));
    }

    setLogger(logger: (msg: string) => void): void {
        this.logger = logger;
    }

    // --- History ---
    async listRevisions(path: string, fileId?: string): Promise<FileRevision[]> {
        const id = fileId ?? this.pathToId.get(path);
        if (!id || !this.files.has(id)) throw new CloudError(`File not found: ${path}`, "not-found", 404);
        const revs = this.revisions.get(id) || [];
        return revs.map((r) => ({
            id: r.id,
            modifiedTime: r.modifiedTime,
            size: r.size,
            hash: r.hash,
        }));
    }

    async getRevisionContent(path: string, revisionId: string, fileId?: string): Promise<ArrayBuffer> {
        const id = fileId ?? this.pathToId.get(path);
        if (!id || !this.files.has(id)) throw new CloudError(`File not found: ${path}`, "not-found", 404);
        const rev = (this.revisions.get(id) || []).find((r) => r.id === revisionId);
        if (rev) return rev.content.slice(0);
        throw new CloudError(`Revision not found: ${revisionId}`, "not-found", 404);
    }

    async setRevisionKeepForever(
        _path: string,
        _revisionId: string,
        _keepForever: boolean,
    ): Promise<void> {}

    // --- Administrative ---
    reset(): void {
        // no-op for tests
    }

    async getAppRootId(): Promise<string> {
        return "mock-app-root-id";
    }

    cloneWithNewVaultName(_newVaultName: string): CloudAdapter {
        return this;
    }

    // --- Test Helpers ---

    /**
     * Manually add a change entry to the changelog (for Changes API testing).
     */
    addChangeEntry(fileId: string, path: string, size: number, hash: string, removed = false): void {
        const cloudFile: CloudFile = {
            id: fileId,
            path,
            mtime: Date.now(),
            size,
            kind: "file",
            hash,
        };
        this.changeLog.push({ fileId, removed, file: removed ? undefined : cloudFile });
    }

    /**
     * Clear the changelog (for clean state in Changes API testing).
     */
    clearChangeLog(): void {
        this.changeLog = [];
    }

    /** Get the current cloud content as text */
    /** Raw stored bytes (ciphertext when E2EE is on) */
    getCloudBytes(path: string): Uint8Array | null {
        const id = this.pathToId.get(path);
        if (!id) return null;
        const file = this.files.get(id);
        return file ? new Uint8Array(file.content) : null;
    }

    getCloudContent(path: string): string | null {
        const id = this.pathToId.get(path);
        if (!id) return null;
        const file = this.files.get(id);
        if (!file) return null;
        return new TextDecoder().decode(file.content);
    }

    /** Get file ID for a path */
    getFileId(path: string): string | undefined {
        return this.pathToId.get(path);
    }

    /** Get the cloud hash for a path */
    getCloudHash(path: string): string | null {
        const id = this.pathToId.get(path);
        if (!id) return null;
        return this.files.get(id)?.hash || null;
    }

    /** Get revision count */
    getRevisionCount(path: string): number {
        const id = this.pathToId.get(path);
        return id ? (this.revisions.get(id) || []).length : 0;
    }

    /** Get current change token (for syncing) */
    getCurrentToken(): string {
        return String(this.changeLog.length);
    }

    /**
     * Set a specific fileId for a path (for rename testing).
     * This allows simulating remote renames where the fileId stays the same
     * but the path changes.
     */
    setFileId(path: string, fileId: string): void {
        const existingFile = this.files.get(fileId);
        if (existingFile) {
            // Update existing file to have the new path
            const oldPath = existingFile.path;
            existingFile.path = path;
            this.pathToId.delete(oldPath);
            this.pathToId.set(path, fileId);
        }
    }

    /**
     * Register a file with a specific fileId without uploading.
     * Useful for setting up rename scenarios.
     */
    registerFileWithId(fileId: string, path: string, content: ArrayBuffer, mtime: number, hash: string): void {
        const stored: StoredFile = {
            id: fileId,
            path,
            content: content.slice(0),
            mtime,
            size: content.byteLength,
            hash,
        };
        this.files.set(fileId, stored);
        this.pathToId.set(path, fileId);
        this.addRevision(fileId, content, hash, mtime);
        this.recordChange(fileId, false, this.toCloudFile(stored));
    }

    /**
     * Add a fake folder entry that will be returned by getFileMetadata.
     * This is used for testing folder-related error handling.
     */
    addFakeFolder(path: string, id?: string): string {
        const folderId = id || `folder_${this.nextFileId++}`;
        // Store as a file with empty content but mark it as a "folder"
        const stored: StoredFile = {
            id: folderId,
            path,
            content: new ArrayBuffer(0),
            mtime: Date.now(),
            size: 0,
            hash: "",
            kind: "folder",
        };
        this.files.set(folderId, stored);
        this.pathToId.set(path, folderId);
        return folderId;
    }

    // --- Error Simulation ---

    /**
     * Set an error to be thrown when a specific method is called.
     * Use clearErrorOnMethod to remove the error.
     */
    setErrorOnMethod(methodName: string, error: Error): void {
        this.errorMap.set(methodName, error);
    }

    /**
     * Clear the error for a specific method.
     */
    clearErrorOnMethod(methodName: string): void {
        this.errorMap.delete(methodName);
    }

    /**
     * Clear all method errors.
     */
    clearAllErrors(): void {
        this.errorMap.clear();
    }

    private maybeThrow(methodName: string): void {
        const error = this.errorMap.get(methodName);
        if (error) {
            throw error;
        }
    }

    // --- Internals ---
    private addRevision(fileId: string, content: ArrayBuffer, hash: string, mtime: number): void {
        if (!this.revisions.has(fileId)) {
            this.revisions.set(fileId, []);
        }
        const revs = this.revisions.get(fileId)!;
        revs.push({
            id: `rev_${this.nextRevisionId++}`,
            modifiedTime: mtime,
            size: content.byteLength,
            hash,
            content: content.slice(0),
        });
    }

    private recordChange(fileId: string, removed: boolean, file?: CloudFile): void {
        this.changeLog.push({ fileId, removed, file });
    }

    private toCloudFile(stored: StoredFile): CloudFile {
        return {
            id: stored.id,
            path: stored.path,
            mtime: stored.mtime,
            size: stored.size,
            kind: stored.kind ?? "file",
            hash: stored.hash,
        };
    }
}

/**
 * Capabilities for hand-made adapter doubles: nothing optional unless named.
 * `contentHash: "md5"` etc. as overrides.
 */
export function testCapabilities(overrides: Partial<CloudCapabilities> = {}): CloudCapabilities {
    return {
        changeFeed: false,
        revisions: false,
        contentHash: null,
        stableIds: true,
        sameNameSiblings: true,
        resumableChunkAlignment: null,
        trash: false,
        conditionalWrite: false,
        ...overrides,
    };
}
