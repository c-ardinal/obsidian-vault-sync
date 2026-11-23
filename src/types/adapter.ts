export interface CloudFile {
    id: string;
    path: string;
    mtime: number;
    size: number;
    kind: "file" | "folder";
    hash?: string;
}

export interface CloudChanges {
    nextPageToken?: string;
    newStartPageToken?: string;
    changes: {
        fileId: string;
        removed: boolean;
        file?: CloudFile;
    }[];
}

/**
 * What a cloud can do, declared once per adapter. The sync decides by these
 * values, never by the adapter's name, so each provider states its own nature
 * instead of imitating Google Drive.
 */
export interface CloudCapabilities {
    /**
     * Incremental change listing: getStartPageToken() and getChanges() are
     * implemented (Drive changes, OneDrive delta, Dropbox list_folder cursor).
     */
    readonly changeFeed: boolean;
    /** Per-file revision history: listRevisions() and getRevisionContent() are implemented */
    readonly revisions: boolean;
    /**
     * What CloudFile.hash holds. "md5" = MD5 of the stored bytes, the same value
     * md5() computes locally. null = no comparable content hash.
     */
    readonly contentHash: "md5" | null;
    /** A file keeps its id across rename and move */
    readonly stableIds: boolean;
    /**
     * A folder can hold two items with the same name. When false, a createOnly
     * upload to a taken name fails with a CloudError of kind "conflict".
     */
    readonly sameNameSiblings: boolean;
    /**
     * Chunked resumable upload (initiateResumableSession / uploadChunk): every
     * chunk except the last must be a multiple of this many bytes. null = none.
     */
    readonly resumableChunkAlignment: number | null;
    /** Removed items can go to a trash and be restored there (no adapter implements it yet) */
    readonly trash: boolean;
    /** Writes can be made conditional on the version read (no adapter implements it yet) */
    readonly conditionalWrite: boolean;
}

/** Capabilities of an adapter that declares none (test doubles, older wrappers). */
export const NO_CLOUD_CAPABILITIES: CloudCapabilities = Object.freeze({
    changeFeed: false,
    revisions: false,
    contentHash: null,
    stableIds: false,
    sameNameSiblings: false,
    resumableChunkAlignment: null,
    trash: false,
    conditionalWrite: false,
});

/** The adapter's capabilities; an adapter without a declaration can do nothing optional. */
export function capabilitiesOf(adapter: Pick<CloudAdapter, "capabilities"> | null | undefined): CloudCapabilities {
    return adapter?.capabilities ?? NO_CLOUD_CAPABILITIES;
}

export interface CloudAdapter {
    name: string;
    vaultName: string;

    /** What this cloud can do (see CloudCapabilities) */
    readonly capabilities: CloudCapabilities;

    // Initialization (optional - pre-warm root folder discovery)
    initialize?(): Promise<void>;

    // Auth
    isAuthenticated(): boolean;
    getAuthUrl(): Promise<string>;
    handleCallback(url: string | URL): Promise<void>;
    logout(): Promise<void>;

    // File Operations
    getFileMetadata(path: string): Promise<CloudFile | null>;
    /**
     * Get metadata by File ID (Strong Consistency preferred).
     * Used for conflict detection where path-based lookup (SearchResults) might be stale.
     * @param fileId The cloud file ID
     * @param knownPath Optional known path to populate the result (avoids expensive path resolution)
     */
    getFileMetadataById(fileId: string, knownPath?: string): Promise<CloudFile | null>;
    downloadFile(fileId: string): Promise<ArrayBuffer>;
    uploadFile(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
        /**
         * createOnly: always create a new file, never update one found at `path`.
         * The caller checked that nothing is there; if another device created the
         * same name since, both files are kept (and renamed apart by the sync)
         * instead of this upload silently overwriting the other device's note.
         */
        opts?: { createOnly?: boolean },
    ): Promise<CloudFile>;
    /**
     * Upload a file using resumable upload protocol (optional).
     * Preferred for large files as it allows resuming interrupted transfers.
     * Falls back to regular uploadFile if not implemented.
     */
    uploadFileResumable?(
        path: string,
        content: ArrayBuffer,
        mtime: number,
        existingFileId?: string,
    ): Promise<CloudFile>;

    /**
     * Initiate a resumable upload session for chunked transfer (optional).
     * Returns a session URI for subsequent uploadChunk() calls.
     */
    initiateResumableSession?(
        path: string,
        totalSize: number,
        mtime: number,
        existingFileId?: string,
    ): Promise<string>;

    /**
     * Upload a chunk to a resumable session using Content-Range (optional).
     * All chunks except the last must be a multiple of capabilities.resumableChunkAlignment.
     * Returns null for intermediate chunks (HTTP 308), CloudFile on final (HTTP 200).
     */
    uploadChunk?(
        sessionUri: string,
        chunk: ArrayBuffer,
        offset: number,
        totalSize: number,
        path: string,
        mtime: number,
    ): Promise<CloudFile | null>;

    /**
     * Delete a file or folder by its cloud ID.
     * When a folder is deleted, the cloud provider handles cascading
     * deletion of all children automatically.
     */
    deleteFile(fileId: string): Promise<void>;
    /**
     * Move/rename a file on the cloud storage without re-uploading content.
     * This preserves the file's revision history by keeping the same fileId.
     *
     * @param fileId         The ID of the file to move/rename
     * @param newName        The new file name (basename only)
     * @param newParentPath  The new parent folder path:
     *                       - null: parent doesn't change (rename only)
     *                       - "": move to root folder
     *                       - "folder/sub": move to specific subfolder
     * @returns Updated CloudFile metadata
     */
    moveFile(fileId: string, newName: string, newParentPath: string | null): Promise<CloudFile>;
    /**
     * Copy a file on the cloud side (nothing is downloaded) into a folder of this
     * adapter's tree; missing folders are created. The source may be in another
     * tree of the same account (e.g. the vault, when this adapter is a clone).
     * The copy gets a new id and no revision history. Optional.
     *
     * @param newParentPath Folder path relative to this adapter's root ("" = root)
     */
    copyFile?(fileId: string, newName: string, newParentPath: string): Promise<CloudFile>;
    createFolder(path: string): Promise<string>;
    ensureFoldersExist(
        folderPaths: string[],
        onProgress?: (current: number, total: number, name: string) => void,
    ): Promise<void>;
    fileExistsById(fileId: string): Promise<boolean>;

    /** Account storage: used / total bytes (optional; one cheap request) */
    getStorageQuota?(): Promise<StorageQuota>;

    // Change feed (only when capabilities.changeFeed)
    getStartPageToken?(): Promise<string>;
    getChanges?(pageToken: string): Promise<CloudChanges>;
    listFiles(folderId?: string): Promise<CloudFile[]>;
    setLogger(logger: (msg: string, level?: string) => void): void;

    /**
     * Reset internal caches (root IDs, folder maps).
     * Used after administrative operations like renames.
     */
    reset(): void;

    /**
     * Get the ID of the shared application root folder (e.g. 'ObsidianVaultSync')
     */
    getAppRootId(): Promise<string>;

    /**
     * Clone this adapter with a new vault name.
     * Used for migration to create temporary adapters.
     * Returns a new adapter instance with the same credentials but different vault name.
     */
    cloneWithNewVaultName(newVaultName: string): CloudAdapter;

    /**
     * Clear internal download cache to free memory between sync cycles.
     */
    clearDownloadCache?(): void;

    /**
     * Get the underlying base adapter (for decorator adapters like EncryptedAdapter).
     * Non-decorator adapters return themselves.
     */
    getBaseAdapter?(): CloudAdapter;

    /**
     * Search for a folder by name and optional parent ID.
     * @param name Folder name to search for
     * @param parentId Optional parent folder ID to restrict search
     * @returns Folder ID if found, null otherwise
     */
    getFolderIdByName?(name: string, parentId?: string): Promise<string | null>;

    // === History (only when capabilities.revisions) ===
    /**
     * @param fileId When known, identifies the file directly. A by-path lookup
     *   fails once another device renamed the file, which made merges miss
     *   their base revision and fall back to a conflict copy.
     */
    listRevisions?(path: string, fileId?: string): Promise<FileRevision[]>;
    getRevisionContent?(path: string, revisionId: string, fileId?: string): Promise<ArrayBuffer>;
    setRevisionKeepForever?(path: string, revisionId: string, keepForever: boolean): Promise<void>;
    deleteRevision?(path: string, revisionId: string): Promise<void>;
}

export interface FileRevision {
    id: string;
    modifiedTime: number; // Unix timestamp
    size: number;
    author?: string; // 更新者名（取得可能な場合）
    keepForever?: boolean;
    hash?: string; // [Sec] コンテンツ整合性検証用 (MD5等)
}

/** The cloud account's storage, in bytes */
export interface StorageQuota {
    /** Total allowed (absent: unlimited) */
    limit?: number;
    /** Used by everything in the account (all services) */
    usage: number;
    /** Of that, files in the cloud's own trash */
    usageInTrash?: number;
}
