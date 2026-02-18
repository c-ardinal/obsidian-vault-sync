import { CloudAdapter, CloudChanges, CloudFile, FileRevision } from "../types/adapter";
import { ICryptoEngine } from "../encryption/interfaces";
import { DecryptionError } from "../encryption/errors";
import {
    isChunkedFormat,
    encryptChunked,
    decryptChunked,
    calculateVSC2Size,
    buildVSC2Header,
    DEFAULT_PLAIN_CHUNK_SIZE,
    HEADER_SIZE,
    IV_SIZE,
} from "../encryption/chunked-crypto";

/**
 * A proxy adapter that transparently encrypts/decrypts file content
 * before it is sent to/received from the underlying cloud storage.
 *
 * Supports two encryption formats:
 * - VSC1 (legacy): Single AES-GCM encryption for the entire file
 * - VSC2 (chunked): File split into ~1MB chunks, each encrypted independently
 *
 * VSC2 is used when content >= largeFileThresholdBytes, reducing peak memory.
 * When the base adapter supports chunked upload (initiateResumableSession + uploadChunk),
 * streaming upload further reduces memory to plaintext + ~6MB buffer.
 */
export class EncryptedAdapter implements CloudAdapter {
    readonly supportsChangesAPI: boolean;
    readonly supportsHash: boolean;
    readonly supportsHistory: boolean;

    /** Sync-cycle scoped cache: fileId -> decrypted content. Call clearDownloadCache() between cycles. */
    private downloadCache = new Map<string, ArrayBuffer>();

    private static readonly UPLOAD_BATCH_SIZE = 5 * 1024 * 1024; // 5 MiB
    private static readonly ALIGN = 262144; // 256 KiB

    constructor(
        private baseAdapter: CloudAdapter,
        private engine: ICryptoEngine,
        private largeFileThresholdBytes: number = 0,
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
        const cached = this.downloadCache.get(fileId);
        if (cached) return cached.slice(0);

        const encryptedContent = await this.baseAdapter.downloadFile(fileId);
        const decrypted = await this.decryptContent(encryptedContent);
        this.downloadCache.set(fileId, decrypted);
        return decrypted;
    }

    /** Clear the sync-cycle download cache. Call between sync cycles. */
    clearDownloadCache(): void {
        this.downloadCache.clear();
    }

    async uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        const encrypted = await this.encryptContent(content);
        const result = await this.baseAdapter.uploadFile(path, encrypted, mtime, existingFileId);
        this.downloadCache.delete(result.id);
        return result;
    }

    async uploadFileResumable(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        // Phase 2: streaming chunked upload (best memory efficiency)
        if (
            this.largeFileThresholdBytes > 0 &&
            content.byteLength >= this.largeFileThresholdBytes &&
            this.baseAdapter.initiateResumableSession &&
            this.baseAdapter.uploadChunk
        ) {
            return this.uploadChunkedStreaming(path, content, mtime, existingFileId);
        }

        // Phase 1 fallback: full encryption then single upload
        const encrypted = await this.encryptContent(content);
        if (this.baseAdapter.uploadFileResumable) {
            const r = await this.baseAdapter.uploadFileResumable(path, encrypted, mtime, existingFileId);
            this.downloadCache.delete(r.id);
            return r;
        }
        const r = await this.baseAdapter.uploadFile(path, encrypted, mtime, existingFileId);
        this.downloadCache.delete(r.id);
        return r;
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
        return this.decryptContent(encryptedContent);
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

    // === Private: Encryption / Decryption ===

    /** Encrypt content using VSC2 (chunked) or VSC1 (legacy) based on threshold. */
    private async encryptContent(content: ArrayBuffer): Promise<ArrayBuffer> {
        if (this.largeFileThresholdBytes > 0 && content.byteLength >= this.largeFileThresholdBytes) {
            return encryptChunked(content, this.engine);
        }
        // Legacy VSC1: [IV(12)][ciphertext]
        const { iv, ciphertext } = await this.engine.encrypt(content);
        const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.byteLength);
        return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
    }

    /** Decrypt content, auto-detecting VSC2 (chunked) or VSC1 (legacy) format. */
    private async decryptContent(data: ArrayBuffer): Promise<ArrayBuffer> {
        if (isChunkedFormat(data)) {
            return decryptChunked(data, this.engine);
        }
        // Legacy VSC1
        if (data.byteLength < 12) {
            throw new DecryptionError("Encrypted file is too short (missing IV).", "format");
        }
        const iv = new Uint8Array(data.slice(0, 12));
        const ciphertext = data.slice(12);
        try {
            return await this.engine.decrypt(ciphertext, iv);
        } catch (e) {
            if (e instanceof DecryptionError) throw e;
            throw new DecryptionError(
                "Decryption failed (wrong password or corrupted data)", "authentication",
            );
        }
    }

    /**
     * Phase 2: Streaming chunked upload.
     * Encrypts one chunk at a time into a write buffer, flushing to the cloud
     * in 256 KiB-aligned batches. Peak memory: plaintext + ~6 MiB buffer.
     */
    private async uploadChunkedStreaming(
        path: string,
        plaintext: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        const chunkSize = DEFAULT_PLAIN_CHUNK_SIZE;
        const totalChunks = Math.max(1, Math.ceil(plaintext.byteLength / chunkSize));
        const totalEncSize = calculateVSC2Size(plaintext.byteLength, chunkSize);

        const sessionUri = await this.baseAdapter.initiateResumableSession!(
            path, totalEncSize, mtime, existingFileId,
        );

        const BATCH = EncryptedAdapter.UPLOAD_BATCH_SIZE;
        const ALIGN = EncryptedAdapter.ALIGN;
        // Write buffer: BATCH + 1 encrypted chunk margin (1 MiB + 64 safety)
        const buf = new Uint8Array(BATCH + 1_048_576 + 64);
        let bufPos = 0;
        let httpOffset = 0;

        // Write VSC2 header
        buf.set(buildVSC2Header(chunkSize, totalChunks), 0);
        bufPos = HEADER_SIZE;

        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, plaintext.byteLength);
            const { iv, ciphertext } = await this.engine.encrypt(plaintext.slice(start, end));

            buf.set(iv, bufPos);
            bufPos += IV_SIZE;
            buf.set(new Uint8Array(ciphertext), bufPos);
            bufPos += ciphertext.byteLength;

            const isLast = i === totalChunks - 1;

            if (bufPos >= BATCH || isLast) {
                if (isLast) {
                    // Final: upload whatever remains
                    const result = await this.baseAdapter.uploadChunk!(
                        sessionUri,
                        buf.buffer.slice(buf.byteOffset, buf.byteOffset + bufPos),
                        httpOffset,
                        totalEncSize,
                        path,
                        mtime,
                    );
                    if (result) {
                        this.downloadCache.delete(result.id);
                        return result;
                    }
                } else {
                    // Intermediate: flush 256 KiB-aligned portion
                    const aligned = Math.floor(bufPos / ALIGN) * ALIGN;
                    if (aligned > 0) {
                        await this.baseAdapter.uploadChunk!(
                            sessionUri,
                            buf.buffer.slice(buf.byteOffset, buf.byteOffset + aligned),
                            httpOffset,
                            totalEncSize,
                            path,
                            mtime,
                        );
                        httpOffset += aligned;
                        buf.copyWithin(0, aligned, bufPos);
                        bufPos -= aligned;
                    }
                }
            }
        }
        throw new Error("Chunked streaming upload did not complete");
    }
}
