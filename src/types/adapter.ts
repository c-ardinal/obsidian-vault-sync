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

export interface CloudAdapter {
    name: string;
    vaultName: string;

    // === Feature Flags ===
    // Changes API support (Google Drive, OneDrive, Dropbox)
    // When true, getChanges() can be used for faster pull detection
    readonly supportsChangesAPI: boolean;

    // Hash support for file content verification
    readonly supportsHash: boolean;

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
    ): Promise<CloudFile>;
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
    createFolder(path: string): Promise<string>;
    ensureFoldersExist(
        folderPaths: string[],
        onProgress?: (current: number, total: number, name: string) => void,
    ): Promise<void>;
    fileExistsById(fileId: string): Promise<boolean>;

    // Fast Sync Support (optional - only if supportsChangesAPI is true)
    getStartPageToken(): Promise<string>;
    getChanges(pageToken: string): Promise<CloudChanges>;
    listFiles(folderId?: string): Promise<CloudFile[]>;
    setLogger(logger: (msg: string, level?: string) => void): void;

    /**
     * Reset internal caches (root IDs, folder maps).
     * Used after administrative operations like renames.
     */
    reset?(): void;

    /**
     * Get the ID of the shared application root folder (e.g. 'ObsidianVaultSync')
     */
    getAppRootId?(): Promise<string>;

    /**
     * Clone this adapter with a new vault name.
     * Used for migration to create temporary adapters.
     * Returns a new adapter instance with the same credentials but different vault name.
     */
    cloneWithNewVaultName?(newVaultName: string): CloudAdapter;

    // === History Support (optional) ===
    readonly supportsHistory: boolean;
    listRevisions?(path: string): Promise<FileRevision[]>;
    getRevisionContent?(path: string, revisionId: string): Promise<ArrayBuffer>;
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
