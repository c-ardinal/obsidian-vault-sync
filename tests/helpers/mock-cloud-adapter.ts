import type { CloudAdapter, CloudFile, CloudChanges, FileRevision } from "../../src/types/adapter";
import { md5 } from "../../src/utils/md5";

interface StoredFile {
    id: string;
    path: string;
    content: ArrayBuffer;
    mtime: number;
    size: number;
    hash: string;
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
    readonly supportsChangesAPI = true;
    readonly supportsHash = true;
    readonly supportsHistory = true;
    readonly vaultName = "MockVault";

    private files = new Map<string, StoredFile>();
    private pathToId = new Map<string, string>();
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
        if (!file) throw new Error(`Cloud file not found: ${fileId}`);
        return file.content.slice(0);
    }

    async uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        targetFileId?: string,
    ): Promise<CloudFile> {
        const hash = md5(content);
        let id = targetFileId || this.pathToId.get(path);

        if (id && this.files.has(id)) {
            // Update existing file
            const existing = this.files.get(id)!;
            existing.content = content.slice(0);
            existing.mtime = mtime;
            existing.size = content.byteLength;
            existing.hash = hash;

            // Add revision
            this.addRevision(path, content, hash, mtime);

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
            this.pathToId.set(path, id);

            // Add first revision
            this.addRevision(path, content, hash, mtime);

            this.recordChange(id, false, this.toCloudFile(stored));
            return this.toCloudFile(stored);
        }
    }

    async deleteFile(fileId: string): Promise<void> {
        const file = this.files.get(fileId);
        if (file) {
            this.pathToId.delete(file.path);
            this.files.delete(fileId);
            this.recordChange(fileId, true);
        }
    }

    async moveFile(
        fileId: string,
        newName: string,
        newParentPath: string | null,
    ): Promise<CloudFile> {
        const file = this.files.get(fileId);
        if (!file) throw new Error(`Cloud file not found: ${fileId}`);

        const oldPath = file.path;
        // 旧パスからパスマップを削除
        this.pathToId.delete(oldPath);

        // 新パスを構築
        const newPath = newParentPath ? `${newParentPath}/${newName}` : newName;
        file.path = newPath;

        // 新パスでパスマップを登録
        this.pathToId.set(newPath, fileId);

        // リビジョンのパスも更新
        const oldRevisions = this.revisions.get(oldPath);
        if (oldRevisions) {
            this.revisions.delete(oldPath);
            this.revisions.set(newPath, oldRevisions);
        }

        this.recordChange(fileId, false, this.toCloudFile(file));
        return this.toCloudFile(file);
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
        return String(this.changeLog.length);
    }

    async getChanges(pageToken: string): Promise<CloudChanges> {
        const from = parseInt(pageToken, 10) || 0;
        const changes = this.changeLog.slice(from).map((c) => ({
            fileId: c.fileId,
            removed: c.removed,
            file: c.file,
        }));
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
    async listRevisions(path: string): Promise<FileRevision[]> {
        const revs = this.revisions.get(path) || [];
        return revs.map((r) => ({
            id: r.id,
            modifiedTime: r.modifiedTime,
            size: r.size,
            hash: r.hash,
        }));
    }

    async getRevisionContent(_path: string, revisionId: string): Promise<ArrayBuffer> {
        for (const revs of this.revisions.values()) {
            const rev = revs.find((r) => r.id === revisionId);
            if (rev) return rev.content.slice(0);
        }
        throw new Error(`Revision not found: ${revisionId}`);
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

    /** Get the current cloud content as text */
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
        return (this.revisions.get(path) || []).length;
    }

    /** Get current change token (for syncing) */
    getCurrentToken(): string {
        return String(this.changeLog.length);
    }

    // --- Internals ---
    private addRevision(path: string, content: ArrayBuffer, hash: string, mtime: number): void {
        if (!this.revisions.has(path)) {
            this.revisions.set(path, []);
        }
        const revs = this.revisions.get(path)!;
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
            kind: "file" as const,
            hash: stored.hash,
        };
    }
}
