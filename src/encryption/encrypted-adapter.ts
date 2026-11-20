import {
    capabilitiesOf,
    CloudAdapter,
    CloudCapabilities,
    CloudChanges,
    CloudFile,
    FileRevision,
} from "../types/adapter";
import { ICryptoEngine } from "./interfaces";
import { DecryptionError } from "./errors";

/**
 * A proxy adapter that transparently encrypts/decrypts file content
 * before it is sent to/received from the underlying cloud storage.
 *
 * All encryption logic is delegated to the ICryptoEngine implementation.
 * This adapter handles only routing (VSC1 vs VSC2 based on threshold)
 * and HTTP batching for streaming uploads.
 */
export class EncryptedAdapter implements CloudAdapter {


    private static readonly UPLOAD_BATCH_SIZE = 5 * 1024 * 1024; // 5 MiB
    /** Chunk alignment when the wrapped cloud declares none (Drive's 256 KiB, as before) */
    private static readonly DEFAULT_ALIGN = 262144;

    constructor(
        private baseAdapter: CloudAdapter,
        private engine: ICryptoEngine,
        private largeFileThresholdBytes: number = 0,
    ) {
    }

    /** Same as the wrapped cloud's: encryption changes the bytes, not what the cloud can do. */
    /**
     * The base cloud's capabilities, except contentHash: the cloud hashes the
     * stored (transformed) bytes, so its hash never describes the vault content.
     */
    get capabilities(): CloudCapabilities {
        return { ...capabilitiesOf(this.baseAdapter), contentHash: null };
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
        // No caching by fileId: another device can replace the content at any time,
        // and a cached copy was served as the NEW version (the sync recorded the new
        // hash with old content, then pushed it back over the other device's edit).
        // The same staleness hit sync-index.json and communication.json re-reads.
        const encryptedContent = await this.baseAdapter.downloadFile(fileId);
        return this.decryptContent(encryptedContent);
    }

    /** Kept for interface compatibility; downloads are no longer cached. */
    clearDownloadCache(): void {}

    async uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
        opts?: { createOnly?: boolean },
    ): Promise<CloudFile> {
        const encrypted = await this.encryptContent(content);
        const result = opts
            ? await this.baseAdapter.uploadFile(path, encrypted, mtime, existingFileId, opts)
            : await this.baseAdapter.uploadFile(path, encrypted, mtime, existingFileId);
        return result;
    }

    async uploadFileResumable(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        // Streaming chunked upload (best memory efficiency)
        if (
            this.largeFileThresholdBytes > 0 &&
            content.byteLength >= this.largeFileThresholdBytes &&
            this.baseAdapter.initiateResumableSession &&
            this.baseAdapter.uploadChunk
        ) {
            return this.uploadChunkedStreaming(path, content, mtime, existingFileId);
        }

        // Fallback: full encryption then single upload
        const encrypted = await this.encryptContent(content);
        if (this.baseAdapter.uploadFileResumable) {
            const r = await this.baseAdapter.uploadFileResumable(
                path,
                encrypted,
                mtime,
                existingFileId,
            );
            return r;
        }
        const r = await this.baseAdapter.uploadFile(path, encrypted, mtime, existingFileId);
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

    /** Stored bytes are copied as they are, so the copy stays readable with the same key */
    get copyFile(): CloudAdapter["copyFile"] {
        const base = this.baseAdapter;
        return base.copyFile ? (id, name, parent) => base.copyFile!(id, name, parent) : undefined;
    }

    async createFolder(path: string): Promise<string> {
        return this.baseAdapter.createFolder(path);
    }

    async ensureFoldersExist(
        folderPaths: string[],
        onProgress?: (current: number, total: number, name: string) => void,
    ): Promise<void> {
        return this.baseAdapter.ensureFoldersExist(folderPaths, onProgress);
    }

    async fileExistsById(fileId: string): Promise<boolean> {
        return this.baseAdapter.fileExistsById(fileId);
    }

    async getStartPageToken(): Promise<string> {
        return this.baseAdapter.getStartPageToken!();
    }

    async getChanges(pageToken: string): Promise<CloudChanges> {
        return this.baseAdapter.getChanges!(pageToken);
    }

    async listFiles(folderId?: string): Promise<CloudFile[]> {
        return this.baseAdapter.listFiles(folderId);
    }

    // === History Support (delegated to base adapter with decryption) ===

    async listRevisions(path: string, fileId?: string): Promise<FileRevision[]> {
        if (!this.baseAdapter.listRevisions) {
            throw new Error("Base adapter does not support listRevisions");
        }
        return this.baseAdapter.listRevisions(path, fileId);
    }

    async getRevisionContent(path: string, revisionId: string, fileId?: string): Promise<ArrayBuffer> {
        if (!this.baseAdapter.getRevisionContent) {
            throw new Error("Base adapter does not support getRevisionContent");
        }
        const encryptedContent = await this.baseAdapter.getRevisionContent(path, revisionId, fileId);
        return this.decryptContent(encryptedContent);
    }

    async setRevisionKeepForever(
        path: string,
        revisionId: string,
        keepForever: boolean,
    ): Promise<void> {
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

    reset(): void {
        this.baseAdapter.reset();
    }

    async getAppRootId(): Promise<string> {
        return this.baseAdapter.getAppRootId();
    }

    cloneWithNewVaultName(newVaultName: string): CloudAdapter {
        return this.baseAdapter.cloneWithNewVaultName(newVaultName);
    }

    getBaseAdapter(): CloudAdapter {
        return this.baseAdapter;
    }

    async getFolderIdByName(name: string, parentId?: string): Promise<string | null> {
        if (!this.baseAdapter.getFolderIdByName) return null;
        return this.baseAdapter.getFolderIdByName(name, parentId);
    }

    // === Private: Encryption / Decryption (pure engine delegation) ===

    /** Encrypt content using VSC2 (chunked) or VSC1 (single blob) based on threshold. */
    private async encryptContent(content: ArrayBuffer): Promise<ArrayBuffer> {
        if (
            this.largeFileThresholdBytes > 0 &&
            content.byteLength >= this.largeFileThresholdBytes
        ) {
            return this.engine.encryptChunked(content);
        }
        return this.engine.encryptToBlob(content);
    }

    /** Decrypt content, auto-detecting VSC2 (chunked) or VSC1 (single blob) format. */
    private async decryptContent(data: ArrayBuffer): Promise<ArrayBuffer> {
        try {
            if (this.engine.isChunkedFormat(data)) {
                return await this.engine.decryptChunked(data);
            }
            if (data.byteLength < this.engine.ivSize) {
                throw new DecryptionError("Encrypted file is too short (missing IV).", "format");
            }
            return await this.engine.decryptFromBlob(data);
        } catch (e) {
            if (e instanceof DecryptionError) throw e;
            // Re-wrap engine DecryptionError (cross-module boundary — different class instance)
            if (e instanceof Error && e.name === "DecryptionError") {
                const err = e as Error & { cause?: unknown; chunkIndex?: unknown };
                const cause =
                    err.cause === "authentication" || err.cause === "format"
                        ? err.cause
                        : "authentication";
                const chunkIndex = typeof err.chunkIndex === "number" ? err.chunkIndex : undefined;
                throw new DecryptionError(e.message, cause, chunkIndex);
            }
            throw new DecryptionError(
                "Decryption failed (wrong password or corrupted data)",
                "authentication",
            );
        }
    }

    /**
     * Streaming chunked upload.
     * Delegates chunk encryption to the engine, then batches encrypted chunks
     * into HTTP uploads aligned as the cloud requires. Peak memory: plaintext + ~6 MiB buffer.
     */
    private async uploadChunkedStreaming(
        path: string,
        plaintext: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile> {
        const totalEncSize = this.engine.calculateChunkedSize(plaintext.byteLength);

        const sessionUri = await this.baseAdapter.initiateResumableSession!(
            path,
            totalEncSize,
            mtime,
            existingFileId,
        );

        const BATCH = EncryptedAdapter.UPLOAD_BATCH_SIZE;
        // Every chunk but the last must be a multiple of what the cloud requires
        // (256 KiB on Drive, 320 KiB on OneDrive).
        const ALIGN =
            capabilitiesOf(this.baseAdapter).resumableChunkAlignment ?? EncryptedAdapter.DEFAULT_ALIGN;
        // Buffer: BATCH + max encrypted chunk size + safety margin
        const maxEncChunkSize =
            this.engine.ivSize + this.engine.getOptimalChunkSize() + this.engine.tagSize;
        const buf = new Uint8Array(BATCH + maxEncChunkSize + 64);
        let bufPos = 0;
        let httpOffset = 0;

        // Write the chunked-format header. The same header goes to encryptChunks:
        // the engine authenticates every chunk together with it and its position.
        const header = this.engine.buildChunkedHeader(plaintext.byteLength);
        buf.set(header, 0);
        bufPos = header.byteLength;

        for await (const { iv, ciphertext, index, totalChunks } of this.engine.encryptChunks(
            plaintext,
            header,
        )) {
            buf.set(iv, bufPos);
            bufPos += iv.byteLength;
            buf.set(new Uint8Array(ciphertext), bufPos);
            bufPos += ciphertext.byteLength;

            const isLast = index === totalChunks - 1;

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
                        return result;
                    }
                } else {
                    // Intermediate: flush the aligned portion
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
