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

    // Fast Sync Support
    getStartPageToken(): Promise<string>;
    getChanges(pageToken: string): Promise<CloudChanges>;
    listFiles(folderId?: string): Promise<CloudFile[]>;
    setLogger(logger: (msg: string) => void): void;
}
