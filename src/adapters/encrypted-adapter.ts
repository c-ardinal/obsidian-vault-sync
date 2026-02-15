import { CloudAdapter, CloudChanges, CloudFile, FileRevision } from "../types/adapter";
import { ICryptoEngine } from "../encryption/interfaces";

/**
 * A proxy adapter that transparently encrypts/decrypts file content
 * before it is sent to/received from the underlying cloud storage.
 *
 * It uses an external ICryptoEngine for actual crypto operations.
 */
export class EncryptedAdapter implements CloudAdapter {
    readonly supportsChangesAPI: boolean;
    readonly supportsHash: boolean;
    readonly supportsHistory: boolean;

    constructor(
        private baseAdapter: CloudAdapter,
        private engine: ICryptoEngine,
    ) {
        this.supportsChangesAPI = baseAdapter.supportsChangesAPI;
        this.supportsHash = baseAdapter.supportsHash;
        this.supportsHistory = baseAdapter.supportsHistory;
    }

    get name(): string {
        return `${this.baseAdapter.name} (Encrypted)`;
    }

    get vaultName(): string {
        return this.baseAdapter.vaultName;
    }

    async initialize(): Promise<void> {
        if (this.baseAdapter.initialize) {
            await this.baseAdapter.initialize();
        }
    }

    isAuthenticated(): boolean {
        return this.baseAdapter.isAuthenticated();
    }

    async getAuthUrl(): Promise<string> {
        return this.baseAdapter.getAuthUrl();
    }

    async handleCallback(url: string | URL): Promise<void> {
        return this.baseAdapter.handleCallback(url);
    }

    async logout(): Promise<void> {
        return this.baseAdapter.logout();
    }

    async getFileMetadata(path: string): Promise<CloudFile | null> {
        return this.baseAdapter.getFileMetadata(path);
    }

    async getFileMetadataById(fileId: string, knownPath?: string): Promise<CloudFile | null> {
        return this.baseAdapter.getFileMetadataById(fileId, knownPath);
    }

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        const encryptedContent = await this.baseAdapter.downloadFile(fileId);

        if (encryptedContent.byteLength < 12) {
            throw new Error("Encrypted file is too short (missing IV).");
        }

        const iv = new Uint8Array(encryptedContent.slice(0, 12));
        const ciphertext = encryptedContent.slice(12);

        // Decrypt using engine
        return await this.engine.decrypt(ciphertext, iv);
    }

    async uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        // Encrypt using engine
        const { iv, ciphertext } = await this.engine.encrypt(content);

        // Combine IV + ciphertext
        const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.byteLength);

        // Upload (isolate buffer to avoid shared ArrayBuffer issues)
        const isolated = combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
        return await this.baseAdapter.uploadFile(path, isolated, mtime, existingFileId);
    }

    async deleteFile(fileId: string): Promise<void> {
        return this.baseAdapter.deleteFile(fileId);
    }

    async moveFile(
        fileId: string,
        newName: string,
        newParentPath: string | null,
    ): Promise<CloudFile> {
        return this.baseAdapter.moveFile(fileId, newName, newParentPath);
    }

    async createFolder(path: string): Promise<string> {
        return this.baseAdapter.createFolder(path);
    }

    async ensureFoldersExist(folderPaths: string[], onProgress?: any): Promise<void> {
        return this.baseAdapter.ensureFoldersExist(folderPaths, onProgress);
    }

    async fileExistsById(fileId: string): Promise<boolean> {
        return this.baseAdapter.fileExistsById(fileId);
    }

    async getStartPageToken(): Promise<string> {
        return this.baseAdapter.getStartPageToken();
    }

    async getChanges(pageToken: string): Promise<CloudChanges> {
        return this.baseAdapter.getChanges(pageToken);
    }

    async listFiles(folderId?: string): Promise<CloudFile[]> {
        return this.baseAdapter.listFiles(folderId);
    }

    // === History Support (delegated to base adapter with decryption) ===

    async listRevisions(path: string): Promise<FileRevision[]> {
        if (!this.baseAdapter.listRevisions) {
            throw new Error("Base adapter does not support listRevisions");
        }
        return this.baseAdapter.listRevisions(path);
    }

    async getRevisionContent(path: string, revisionId: string): Promise<ArrayBuffer> {
        if (!this.baseAdapter.getRevisionContent) {
            throw new Error("Base adapter does not support getRevisionContent");
        }
        const encryptedContent = await this.baseAdapter.getRevisionContent(path, revisionId);

        if (encryptedContent.byteLength < 12) {
            throw new Error("Encrypted revision is too short (missing IV).");
        }

        const iv = new Uint8Array(encryptedContent.slice(0, 12));
        const ciphertext = encryptedContent.slice(12);

        return await this.engine.decrypt(ciphertext, iv);
    }

    async setRevisionKeepForever(path: string, revisionId: string, keepForever: boolean): Promise<void> {
        if (!this.baseAdapter.setRevisionKeepForever) {
            throw new Error("Base adapter does not support setRevisionKeepForever");
        }
        return this.baseAdapter.setRevisionKeepForever(path, revisionId, keepForever);
    }

    async deleteRevision(path: string, revisionId: string): Promise<void> {
        if (!this.baseAdapter.deleteRevision) {
            throw new Error("Base adapter does not support deleteRevision");
        }
        return this.baseAdapter.deleteRevision(path, revisionId);
    }

    setLogger(logger: (msg: string, level?: string) => void): void {
        this.baseAdapter.setLogger(logger);
    }
}
