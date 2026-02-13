# ファイル移動ハンドリング改善 - 詳細実装計画

> 作成日: 2026-02-13
> ステータス: **完了** ✅ (全 3 フェーズ実装済み)

## 目的

ファイル/フォルダの「移動」操作を「削除→再追加」ではなく、単一の「Move」操作として処理する。
これにより以下を達成する：

1. **Google Drive 上の Revision 履歴を維持**（fileId が保持される）
2. **不要な再アップロード/再ダウンロードを削減**（帯域・API クォータの節約）
3. **通知の正確さ向上**（「削除+作成」ではなく「移動」として表示）

---

## 前提知識

### 現状のアーキテクチャ

| ファイル                                            | 役割                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/main.ts` L461-474                              | Obsidian の `rename` イベントを捕捉し、`markRenamed` / `markFolderRenamed` を呼ぶ |
| `src/sync-manager/state.ts` L313-370                | `markRenamed` / `markFolderRenamed` — ダーティ状態管理                            |
| `src/sync-manager/sync-orchestration.ts` L1044-1681 | `smartPush` — アップロード・削除の実行                                            |
| `src/sync-manager/sync-orchestration.ts` L391-736   | `smartPull` — SmartPull (インデックス比較)                                        |
| `src/sync-manager/sync-orchestration.ts` L738-1038  | `pullViaChangesAPI` — Changes API 経由の Pull                                     |
| `src/adapters/google-drive.ts` L632-702             | `uploadFile` — Google Drive へのアップロード/更新                                 |
| `src/types/adapter.ts` L20-76                       | `CloudAdapter` インターフェース                                                   |

### Google Drive API の Move 仕様

Google Drive API では、`PATCH` リクエストで以下を同時に変更可能：

```
PATCH https://www.googleapis.com/drive/v3/files/{fileId}
  ?addParents={newParentId}&removeParents={oldParentId}

Body: { "name": "newFileName" }
```

- `name` のみ変更 → リネーム
- `parents` のみ変更 → フォルダ移動
- 両方変更 → リネーム + フォルダ移動

**重要**: これにより `fileId` は不変であり、Revision 履歴が維持される。

### 現状の問題点まとめ

| 操作                   | リネーム (同一フォルダ)             | 移動 (フォルダ変更)                |
| ---------------------- | ----------------------------------- | ---------------------------------- |
| **Push: ローカル検出** | ✅ `markRenamed` でインデックス移行 | ❌ `markDeleted` + `markDirty`     |
| **Push: API 操作**     | ✅ `forcePush` → PATCH (name 変更)  | ❌ 旧ファイル削除 + 新ファイル作成 |
| **Pull: Changes API**  | ✅ fileId ベースでリネーム検出      | ✅ fileId ベースでリネーム検出     |
| **Pull: SmartPull**    | ❌ 削除 + 追加                      | ❌ 削除 + 追加                     |
| **履歴**               | ⚠️ fileId 維持でほぼ保持            | ❌ 新ファイルとして作成 → 履歴断絶 |

---

## Phase 1: Push 側のファイル移動を Move API で処理 + 通知統一

### 概要

ローカルでファイルを移動した際、Push 時に Google Drive の Move API（`PATCH` + `addParents` / `removeParents`）を使って移動として処理する。

### タスク 1.1: `CloudAdapter` に `moveFile` メソッドを追加

**対象ファイル**: `src/types/adapter.ts`

`CloudAdapter` インターフェースに以下を追加（L56 `deleteFile` の後あたり）：

```typescript
/**
 * Move/rename a file on the cloud storage.
 * Changes the file's name and/or parent folder without re-uploading content.
 * This preserves the file's revision history.
 *
 * @param fileId    The ID of the file to move
 * @param newName   The new file name (basename only)
 * @param newParentPath  The new parent folder path (or null if parent doesn't change)
 * @returns Updated CloudFile metadata
 */
moveFile(
    fileId: string,
    newName: string,
    newParentPath: string | null,
): Promise<CloudFile>;
```

### タスク 1.2: `GoogleDriveAdapter` に `moveFile` を実装

**対象ファイル**: `src/adapters/google-drive.ts`

`deleteFile` メソッド（L704-708）の直後に新メソッドを追加：

```typescript
async moveFile(
    fileId: string,
    newName: string,
    newParentPath: string | null,
): Promise<CloudFile> {
    // 1. 現在のファイルの親フォルダを取得
    const currentMeta = await this.fetchWithAuth(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,parents,modifiedTime,size,md5Checksum`,
    );
    const currentFile = await currentMeta.json();
    const oldParentId = currentFile.parents?.[0];

    // 2. 新しい親フォルダの ID を解決（パスが変わる場合のみ）
    let newParentId: string | null = null;
    if (newParentPath !== null) {
        // newParentPath は "folder/subfolder" のような相対パス
        // resolveParentId は "folder/subfolder/dummy.txt" のようなファイルパスを期待するため、
        // ダミーのファイル名を付与して呼ぶ
        newParentId = await this.resolveParentId(newParentPath + "/__dummy__", true);
    }

    // 3. PATCH リクエストを構築
    const queryParams: string[] = [`fields=id,name,modifiedTime,size,md5Checksum`];
    if (newParentId && oldParentId && newParentId !== oldParentId) {
        queryParams.push(`addParents=${newParentId}`);
        queryParams.push(`removeParents=${oldParentId}`);
    }

    const metadata: any = { name: newName };

    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?${queryParams.join("&")}`;
    const response = await this.fetchWithAuth(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
    });

    const data = await response.json();

    // 4. 新しいパスを構築
    const parentPath = newParentPath !== null ? newParentPath : "";
    const fullPath = parentPath ? `${parentPath}/${newName}` : newName;

    const result: CloudFile = {
        id: data.id,
        path: fullPath,
        mtime: new Date(data.modifiedTime).getTime(),
        size: parseInt(data.size || "0"),
        kind: "file",
        hash: data.md5Checksum,
    };

    // 5. キャッシュ更新
    this.idToPathCache.set(result.id, result.path);
    this.resolvePathCache.set(result.id, result.path);

    return result;
}
```

> **注意**: `resolveParentId` は `private` なので、`moveFile` が同じクラス内にあるため問題なし。

### タスク 1.3: `LocalFileIndex` に `pendingMove` フラグを追加

**対象ファイル**: `src/sync-manager/types.ts`

`LocalFileIndex` のエントリ型に以下のフィールドを追加（L37 `forcePush` の後、L38 `}` の前）：

```typescript
/** If set, this file should be moved on remote instead of re-uploaded.
 *  Contains the old path from which the file was moved. */
pendingMove?: {
    oldPath: string;
};
```

### タスク 1.4: `markRenamed` を修正 — 移動でもインデックス移行する

**対象ファイル**: `src/sync-manager/state.ts`

現在の `markRenamed` 関数（L313-346）を以下のように修正する。
**変更の核心**: `isMove` の場合も `markDeleted` + `markDirty` ではなく、インデックス移行 + `pendingMove` フラグを設定する。

```typescript
export function markRenamed(ctx: SyncContext, oldPath: string, newPath: string): void {
    if (shouldIgnore(ctx, newPath)) return;

    const oldDir = oldPath.substring(0, oldPath.lastIndexOf("/"));
    const newDir = newPath.substring(0, newPath.lastIndexOf("/"));
    const isMove = oldDir !== newDir;

    // 未同期ファイルのリネーム（oldPath がインデックスになく dirtyPaths にある）
    if (ctx.dirtyPaths.has(oldPath) && !ctx.index[oldPath]) {
        ctx.dirtyPaths.delete(oldPath);
        ctx.dirtyPaths.add(newPath);
        ctx.log(`[Dirty] Removed (renamed before sync): ${oldPath}`);
        ctx.log(`[Dirty] Marked (renamed before sync): ${newPath}`);
        return;
    }

    // 既存インデックスエントリを移行
    ctx.dirtyPaths.delete(oldPath);

    if (ctx.index[oldPath]) {
        ctx.index[newPath] = { ...ctx.index[oldPath], forcePush: true };
        if (isMove) {
            // 移動の場合: pendingMove フラグを追加
            ctx.index[newPath].pendingMove = { oldPath };
        }
        delete ctx.index[oldPath];
    }

    if (ctx.localIndex[oldPath]) {
        ctx.localIndex[newPath] = { ...ctx.localIndex[oldPath], forcePush: true };
        if (isMove) {
            ctx.localIndex[newPath].pendingMove = { oldPath };
        }
        delete ctx.localIndex[oldPath];
    }

    ctx.dirtyPaths.add(newPath);
    ctx.log(
        `[Dirty] Marked (${isMove ? "moved" : "renamed"}): ${newPath} (Migrated ID from ${oldPath})`,
    );
}
```

### タスク 1.5: `markFolderRenamed` を修正 — 子ファイルにもインデックス移行 + `pendingMove`

**対象ファイル**: `src/sync-manager/state.ts`

現在の `markFolderRenamed` 関数（L348-370）を以下のように修正する：

```typescript
export function markFolderRenamed(
    ctx: SyncContext,
    oldFolderPath: string,
    newFolderPath: string,
): void {
    const oldPrefix = oldFolderPath + "/";
    const newPrefix = newFolderPath + "/";

    for (const oldPath of Object.keys(ctx.index)) {
        if (oldPath.startsWith(oldPrefix)) {
            if (shouldIgnore(ctx, oldPath)) continue;

            const newPath = newPrefix + oldPath.slice(oldPrefix.length);
            if (shouldIgnore(ctx, newPath)) continue;

            // インデックスを移行
            ctx.index[newPath] = {
                ...ctx.index[oldPath],
                forcePush: true,
                pendingMove: { oldPath },
            };
            delete ctx.index[oldPath];

            if (ctx.localIndex[oldPath]) {
                ctx.localIndex[newPath] = {
                    ...ctx.localIndex[oldPath],
                    forcePush: true,
                    pendingMove: { oldPath },
                };
                delete ctx.localIndex[oldPath];
            }

            // dirtyPaths を更新
            ctx.dirtyPaths.delete(oldPath);
            ctx.dirtyPaths.add(newPath);
            ctx.log(`[Dirty] Marked (folder rename/move): ${oldPath} -> ${newPath} (Migrated ID)`);
        }
    }
}
```

### タスク 1.6: `smartPush` の uploadQueue 構築ロジックに Move 処理を追加

**対象ファイル**: `src/sync-manager/sync-orchestration.ts`

`smartPush` 関数の dirtyPathTasks ループ内（現在 L1193 付近から始まる各 path の処理）で、
uploadQueue に追加する前に `pendingMove` チェックを挿入する。

具体的には、L1246-1311（ハッシュチェック → uploadQueue.push の部分）の **前** に、
以下の Move 処理ブロックを追加する：

```typescript
// === MOVE DETECTION ===
// If this file has a pendingMove flag, use Move API instead of re-upload
const indexEntry = ctx.index[path];
if (indexEntry?.pendingMove && indexEntry.fileId) {
    const moveInfo = indexEntry.pendingMove;
    try {
        // 新しいパスからファイル名と親パスを抽出
        const newName = path.split("/").pop()!;
        const newParentPath = path.substring(0, path.lastIndexOf("/")) || null;

        // Move API を呼び出し
        const moved = await ctx.adapter.moveFile(indexEntry.fileId, newName, newParentPath);

        // インデックス更新（pendingMove をクリア）
        const updatedEntry = {
            fileId: moved.id,
            mtime: moved.mtime,
            size: moved.size,
            hash: moved.hash,
            lastAction: "push" as const,
            ancestorHash: ctx.localIndex[path]?.ancestorHash || moved.hash,
        };
        ctx.index[path] = updatedEntry;
        ctx.localIndex[path] = { ...updatedEntry };
        ctx.dirtyPaths.delete(path);

        await ctx.log(`[Smart Push] Moved: ${moveInfo.oldPath} -> ${path}`);
        await ctx.notify(
            "noticeFileMoved",
            `${moveInfo.oldPath.split("/").pop()} -> ${path.split("/").pop()}`,
        );
        return; // この path の処理完了
    } catch (e) {
        await ctx.log(`[Smart Push] Move API failed for ${path}, falling back to re-upload: ${e}`);
        // Move に失敗した場合は pendingMove をクリアして通常のアップロードにフォールバック
        delete indexEntry.pendingMove;
        if (ctx.localIndex[path]) {
            delete ctx.localIndex[path].pendingMove;
        }
    }
}
```

**挿入位置**: `smartPush` 内の `dirtyPathTasks.push(async () => { ... })` コールバック内、
現在の `if (stat.type === "folder")` ブロック（L1224-1237）の直後、
`try { const content = await ctx.app.vault.adapter.readBinary(path);` の直前（L1247 付近）。

### タスク 1.7: `noticeFileMoved` 通知キーを追加

#### 1.7a: i18n メッセージ追加

**対象ファイル**: `src/i18n.ts`

英語メッセージ（`noticeFileRenamed` の近く、L90 付近）に追加：

```typescript
noticeFileMoved: "📂 [Sync] Moved",
```

日本語メッセージ（L240 付近）に追加：

```typescript
noticeFileMoved: "📂 [同期] 移動反映",
```

#### 1.7b: notification-matrix に追加

**対象ファイル**: `src/sync-manager/notification-matrix.ts`

`VERBOSE` テーブル内の `noticeFileRenamed` エントリの直後（L162 付近）に追加：

```typescript
noticeFileMoved: {
    "initial-sync": true,
    "startup-sync": true,
    "manual-sync": true,
    "timer-sync": true,
    "save-sync": true,
    "modify-sync": true,
    "layout-sync": true,
    "full-scan": true,
},
```

### タスク 1.8: `forcePush` / `pendingMove` のクリーンアップ

Push 成功後、`forcePush` と `pendingMove` は不要になるため、
`smartPush` の uploadFile 成功時のインデックス更新コード（L1516-1523）で `pendingMove` を含めないようにする。

現在のコード：

```typescript
const entry = {
    fileId: uploaded.id,
    mtime: file.mtime,
    size: uploaded.size,
    hash: uploaded.hash,
    lastAction: "push" as const,
    ancestorHash: previousAncestorHash || uploaded.hash,
};
```

このコードは新しいオブジェクトを作成しているため、`pendingMove` は自動的に含まれない。**変更不要**。

---

## Phase 2: SmartPull でのリネーム/移動検出強化

### 概要

SmartPull（インデックス比較方式）は現在 `fileId` マッチングを行っていない。
リモートインデックスと比較する際に、同じ `fileId` が異なるパスにある場合をリネーム/移動として検出する。

### タスク 2.1: SmartPull にリネーム/移動検出ロジックを追加

**対象ファイル**: `src/sync-manager/sync-orchestration.ts`

`smartPull` 関数内、`toDownload` と `toDeleteLocal` の配列を構築する 2 つのループの**前**
（L517-522 の `localIdToPath` マップ構築の直後）に「Move 検出パス」を追加する。

**アルゴリズム**:

1. ローカルインデックスとリモートインデックスの両方の `fileId → path` マップを構築
2. 同じ `fileId` が異なるパスに存在する場合、リネーム/移動として処理
3. 検出された Move はローカルでリネームを実行し、インデックスを移行
4. 移動処理されたパスは `toDownload` / `toDeleteLocal` から除外

```typescript
// === RENAME/MOVE DETECTION (fileId based) ===
const remoteIdToPath = new Map<string, string>();
for (const [p, entry] of Object.entries(remoteIndex)) {
    if (entry.fileId) remoteIdToPath.set(entry.fileId, p);
}

const processedMoves = new Set<string>(); // 処理済みのローカルパスを記録

for (const [fileId, localPath] of localIdToPath.entries()) {
    const remotePath = remoteIdToPath.get(fileId);
    if (!remotePath || remotePath === localPath) continue;
    // localPath と remotePath が異なる → リモートでリネーム/移動されたファイル

    if (shouldIgnore(ctx, remotePath)) continue;
    if (isManagedSeparately(remotePath)) continue;

    // ターゲットパスが既にローカルに存在しないか確認
    const targetExists = await ctx.app.vault.adapter.exists(remotePath);
    const sourceExists = await ctx.app.vault.adapter.exists(localPath);

    if (sourceExists && !targetExists) {
        try {
            // 親フォルダを作成（存在しなければ）
            const parentDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
            if (parentDir) {
                // Obsidian の vault.adapter には mkdir がないので、
                // createFolder を使うか、vault.createFolder を使う
                if (!(await ctx.app.vault.adapter.exists(parentDir))) {
                    await ctx.app.vault.createFolder(parentDir).catch(() => {});
                }
            }

            await ctx.app.vault.adapter.rename(localPath, remotePath);

            // インデックス移行
            if (ctx.index[localPath]) {
                ctx.index[remotePath] = { ...ctx.index[localPath] };
                delete ctx.index[localPath];
            }
            if (ctx.localIndex[localPath]) {
                ctx.localIndex[remotePath] = { ...ctx.localIndex[localPath] };
                delete ctx.localIndex[localPath];
            }
            if (ctx.dirtyPaths.has(localPath)) {
                ctx.dirtyPaths.delete(localPath);
                ctx.dirtyPaths.add(remotePath);
            }

            processedMoves.add(localPath);
            processedMoves.add(remotePath);

            await ctx.log(
                `[Smart Pull] Remote rename/move detected: ${localPath} -> ${remotePath}`,
            );
            await ctx.notify(
                "noticeFileRenamed",
                `${localPath.split("/").pop()} -> ${remotePath.split("/").pop()}`,
            );
        } catch (e) {
            await ctx.log(`[Smart Pull] Rename failed: ${localPath} -> ${remotePath}: ${e}`);
        }
    }
}
```

### タスク 2.2: `toDownload` / `toDeleteLocal` ループで Move 処理済みパスを除外

**対象ファイル**: `src/sync-manager/sync-orchestration.ts`

タスク 2.1 で作成した `processedMoves` セットを使い、以下の 2 箇所にガードを追加：

1. **`toDownload` へ追加するループ** (L523 付近 `for (const [path, remoteEntry] of Object.entries(remoteIndex))`)：
   ループの先頭に追加：

    ```typescript
    if (processedMoves.has(path)) continue;
    ```

2. **`toDeleteLocal` へ追加するループ** (L576 付近 `for (const path of Object.keys(ctx.localIndex))`)：
   ループ内の `if (!remoteIndex[path])` チェックの直前に追加：
    ```typescript
    if (processedMoves.has(path)) continue;
    ```

### タスク 2.3: リモートインデックスのハッシュ更新

Move 検出後、リモートインデックスのハッシュと mtime も反映する必要がある。
タスク 2.1 のインデックス移行コードで、リモートのエントリ情報を反映：

```typescript
// ctx.index[remotePath] の更新時にリモートのハッシュも反映
const remoteEntry = remoteIndex[remotePath];
if (ctx.index[remotePath] && remoteEntry) {
    ctx.index[remotePath].hash = remoteEntry.hash || ctx.index[remotePath].hash;
    ctx.index[remotePath].mtime = remoteEntry.mtime || ctx.index[remotePath].mtime;
    ctx.index[remotePath].ancestorHash = remoteEntry.hash; // リモートと一致 → ancestor 更新
}
if (ctx.localIndex[remotePath] && remoteEntry) {
    ctx.localIndex[remotePath].hash = remoteEntry.hash || ctx.localIndex[remotePath].hash;
    ctx.localIndex[remotePath].mtime = remoteEntry.mtime || ctx.localIndex[remotePath].mtime;
    ctx.localIndex[remotePath].ancestorHash = remoteEntry.hash;
    ctx.localIndex[remotePath].lastAction = "pull";
}
```

---

## Phase 3: フォルダ移動/リネームの最適化

### 概要

現在のアーキテクチャではフォルダの ID をトラッキングしていないため、
フォルダの移動は個別ファイルの Move 操作の集合として処理する。
Phase 1 の `markFolderRenamed` 修正で各子ファイルに `pendingMove` が付くため、
Push 時に自動的にファイル単位の Move API が発行される。

ただし、**フォルダ自体の Cloud 上でのリネーム/移動**は別途処理が必要。

### タスク 3.1: フォルダの Move/Rename をバッチ処理

**対象ファイル**: `src/sync-manager/sync-orchestration.ts`

`smartPush` の FOLDER DELETION PHASE（L1116-1169）の **前** に、
FOLDER MOVE PHASE を追加する。

`pendingMove` を持つ dirty ファイルを走査し、共通のフォルダ移動パターンを検出→
フォルダ単位での Move API 呼び出しにまとめる。

```typescript
// === FOLDER MOVE PHASE ===
// Detect common folder moves: if multiple files have pendingMove and share
// the same old/new parent prefix, we can move the folder itself once.
if (ctx.dirtyPaths.size > 0) {
    // Group pendingMove entries by their common folder move pattern
    const folderMoveMap = new Map<string, { newFolder: string; count: number }>();

    for (const path of ctx.dirtyPaths) {
        const entry = ctx.index[path];
        if (!entry?.pendingMove) continue;

        const oldPath = entry.pendingMove.oldPath;
        const oldDir = oldPath.substring(0, oldPath.lastIndexOf("/"));
        const newDir = path.substring(0, path.lastIndexOf("/"));

        if (oldDir && newDir && oldDir !== newDir) {
            const key = oldDir;
            const existing = folderMoveMap.get(key);
            if (existing) {
                existing.count++;
                // 検証: 全て同じ新フォルダに移動しているか
                if (existing.newFolder !== newDir) {
                    // 異なる宛先 → フォルダ単位の最適化は不可
                    folderMoveMap.delete(key);
                }
            } else {
                folderMoveMap.set(key, { newFolder: newDir, count: 1 });
            }
        }
    }

    // 2 ファイル以上が同じフォルダ移動パターンの場合、フォルダごと移動することを検討
    // ただし、現アーキテクチャではフォルダ ID をトラッキングしていないため、
    // リモートからフォルダの getFileMetadata で ID を取得する必要がある
    for (const [oldFolder, { newFolder, count }] of folderMoveMap.entries()) {
        if (count < 2) continue; // 単一ファイルなら個別 Move で十分

        try {
            const folderMeta = await ctx.adapter.getFileMetadata(oldFolder);
            if (folderMeta && folderMeta.kind === "folder") {
                // フォルダ自体を Move
                const newFolderName = newFolder.split("/").pop()!;
                const newFolderParent = newFolder.substring(0, newFolder.lastIndexOf("/")) || null;

                await ctx.adapter.moveFile(folderMeta.id, newFolderName, newFolderParent);

                await ctx.log(
                    `[Smart Push] Folder moved: ${oldFolder} -> ${newFolder} (${count} files)`,
                );
                await ctx.notify(
                    "noticeFileMoved",
                    `${oldFolder.split("/").pop()} -> ${newFolderName}`,
                );

                // 配下の pendingMove をクリア（フォルダごと移動済み）
                const oldPrefix = oldFolder + "/";
                for (const path of Array.from(ctx.dirtyPaths)) {
                    const entry = ctx.index[path];
                    if (entry?.pendingMove?.oldPath.startsWith(oldPrefix)) {
                        delete entry.pendingMove;
                        delete entry.forcePush;
                        if (ctx.localIndex[path]) {
                            delete ctx.localIndex[path].pendingMove;
                            delete ctx.localIndex[path].forcePush;
                        }
                        ctx.dirtyPaths.delete(path);
                    }
                }

                // Google Drive の folderCache を無効化
                // （フォルダパスが変わったため、古いキャッシュは不正確）
                // adapter 内部のキャッシュクリアは adapter 側で行われる想定
            }
        } catch (e) {
            await ctx.log(`[Smart Push] Folder move failed: ${oldFolder} -> ${newFolder}: ${e}`);
            // フォールバック: 個別ファイルの Move が引き続き処理される
        }
    }
}
```

### タスク 3.2: `moveFile` のフォルダ対応（Google Drive Adapter）

**対象ファイル**: `src/adapters/google-drive.ts`

タスク 1.2 で実装した `moveFile` は既にフォルダの移動にも対応している
（Google Drive API の PATCH + `addParents` / `removeParents` はフォルダにも使える）。
ただし、フォルダの場合は `md5Checksum` が返らないため、結果パースを微調整する：

```typescript
// moveFile 内の CloudFile 構築を修正
const result: CloudFile = {
    id: data.id,
    path: fullPath,
    mtime: new Date(data.modifiedTime).getTime(),
    size: parseInt(data.size || "0"),
    kind: data.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
    hash: data.md5Checksum, // フォルダの場合は undefined
};
```

`moveFile` の API リクエストにも `mimeType` を fields に追加：

```typescript
// fields パラメータを更新
const queryParams: string[] = [`fields=id,name,mimeType,modifiedTime,size,md5Checksum`];
```

### タスク 3.3: Google Drive Adapter のフォルダキャッシュ更新

**対象ファイル**: `src/adapters/google-drive.ts`

`moveFile` 成功後、内部のフォルダキャッシュ（`folderCache`, `resolveCache`）を更新する必要がある。
移動元のフォルダパスに紐づくキャッシュを無効化し、新しいパスで再登録する：

```typescript
// moveFile の末尾に追加（result return の前）
// フォルダキャッシュの更新
if (result.kind === "folder") {
    // 旧パスのキャッシュを無効化（正確な旧パスがわからないため、ID で検索）
    for (const [cachedPath, cachedId] of this.folderCache.entries()) {
        if (cachedId === fileId) {
            this.folderCache.delete(cachedPath);
            this.resolveCache.delete(cachedPath);
            break;
        }
    }
    // 新パスでキャッシュ登録
    this.folderCache.set(fullPath, result.id);
    this.resolveCache.set(fullPath, Promise.resolve(result.id));
}
```

---

## テスト計画

### 単体テスト

**新規テストファイル**: `tests/tests/code-scenario/file-move.test.ts`

テストケースの概要：

#### Phase 1 テスト

| #   | テスト名                                                               | 検証内容                                                      |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | `markRenamed: file move sets pendingMove flag`                         | 移動（異フォルダ）で `pendingMove` が設定されること           |
| 2   | `markRenamed: file rename within same folder does NOT set pendingMove` | 同一フォルダのリネームでは `pendingMove` なし                 |
| 3   | `markRenamed: index migration preserves fileId for moves`              | 移動時にインデックスが正しく移行されること                    |
| 4   | `markFolderRenamed: all children get pendingMove`                      | フォルダリネームで全子ファイルに `pendingMove` が付くこと     |
| 5   | `smartPush: uses moveFile API when pendingMove is set`                 | `pendingMove` がある場合 `adapter.moveFile` が呼ばれること    |
| 6   | `smartPush: falls back to upload when moveFile fails`                  | `moveFile` 失敗時に通常のアップロードにフォールバックすること |
| 7   | `smartPush: clears pendingMove after successful move`                  | Move 成功後にフラグがクリアされること                         |

#### Phase 2 テスト

| #   | テスト名                                                        | 検証内容                                       |
| --- | --------------------------------------------------------------- | ---------------------------------------------- |
| 8   | `smartPull: detects remote rename by fileId match`              | リモートでリネームされたファイルを検出すること |
| 9   | `smartPull: skips move if target already exists`                | 移動先が既に存在する場合はスキップすること     |
| 10  | `smartPull: excludes moved files from toDownload/toDeleteLocal` | Move 処理されたパスが重複処理されないこと      |

#### Phase 3 テスト

| #   | テスト名                                                           | 検証内容                                                               |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 11  | `smartPush: batch folder move when multiple files share pattern`   | 複数ファイルの共通パターンで `moveFile` がフォルダに対して呼ばれること |
| 12  | `smartPush: falls back to individual moves when folder move fails` | フォルダ Move 失敗時に個別ファイル Move にフォールバックすること       |

### 統合テスト（手動検証項目）

1. **ファイルをフォルダ間で移動** → Google Drive Web UI で fileId が同一であることを確認
2. **フォルダ名を変更** → 配下の全ファイルが正しくリネームされることを確認
3. **別デバイスで移動したファイルが Pull で正しく反映される**ことを確認
4. **ネットワークエラー時** → Move API 失敗後にリトライで正しく処理されることを確認

---

## 実装順序と依存関係

```
Phase 1:
  1.1 (adapter interface) ← 1.2 (adapter impl)
  1.3 (types)             ← 1.4, 1.5 (state.ts)
  1.7 (i18n, notification-matrix) ← 独立
  1.6 (smartPush) ← 1.1 ~ 1.5 すべて

Phase 2:
  2.1, 2.2, 2.3 ← Phase 1 完了後（ただし独立しているため並行開発可能）

Phase 3:
  3.1 ← Phase 1 完了後
  3.2, 3.3 ← 1.2 完了後
```

## リスクと軽減策

| リスク                                  | 影響度 | 軽減策                                                                    |
| --------------------------------------- | ------ | ------------------------------------------------------------------------- |
| Move API 失敗（権限不足、ネットワーク） | 中     | フォールバック: 従来の削除+再アップロード（タスク 1.6）                   |
| フォルダ移動時の API レートリミット     | 低     | フォルダ単位の一括移動で API コール数を削減（Phase 3）                    |
| 同時に複数デバイスで移動操作            | 中     | fileId ベースの処理により衝突は最小限。最悪の場合は削除+再作成に戻る      |
| Google Drive のフォルダキャッシュ不整合 | 中     | Move 後にキャッシュをクリア (タスク 3.3)                                  |
| `pendingMove` がクリアされずに残る      | 低     | Push 成功時に新しいオブジェクト作成でクリア + フォールバック時に `delete` |
