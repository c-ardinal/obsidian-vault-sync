export interface CloudFile {
    id: string;
    path: string;
    mtime: number;
    size: number;
    kind: "file" | "folder";
    hash?: string;
}

export interface CloudChanges {
    newStartPageToken?: string;
    changes: {
        fileId: string;
        removed: boolean;
        file?: CloudFile;
    }[];
}

export interface CloudAdapter {
    name: string;

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
    downloadFile(fileId: string): Promise<ArrayBuffer>;
    uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<CloudFile>;
    deleteFile(fileId: string): Promise<void>;
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
    setLogger(logger: (msg: string) => void): void;

    // === History Support (optional) ===
    readonly supportsHistory: boolean;
    listRevisions?(path: string): Promise<FileRevision[]>;
    getRevisionContent?(path: string, revisionId: string): Promise<ArrayBuffer>;
    setRevisionKeepForever?(path: string, revisionId: string, keepForever: boolean): Promise<void>;
}

export interface FileRevision {
    id: string;
    modifiedTime: number; // Unix timestamp
    size: number;
    author?: string; // 更新者名（取得可能な場合）
    keepForever?: boolean;
    hash?: string; // [Sec] コンテンツ整合性検証用 (MD5等)
}
