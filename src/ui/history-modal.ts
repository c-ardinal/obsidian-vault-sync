import {
    App,
    Modal,
    TFile,
    ButtonComponent,
    setIcon,
    DropdownComponent,
    ExtraButtonComponent,
    Menu,
} from "obsidian";
import { SyncManager } from "../sync-manager";
import { FileRevision } from "../types/adapter";
import { diff_match_patch } from "diff-match-patch";
import { PromptModal } from "./prompt-modal";

export class HistoryModal extends Modal {
    private revisions: FileRevision[] = [];
    private selectedRevision: FileRevision | null = null;
    private baseRevision: FileRevision | null = null; // null means Local File
    private fileContent: string | null = null; // Current local content for diff
    private listScrollLeft: number = 0; // Preserve horizontal scroll position
    private listScrollTop: number = 0; // Preserve vertical scroll position
    private diffMode: "unified" | "split" = "unified";
    private isDrawerOpen: boolean = false;

    // Cache: revisionId -> content string (Persistent across modal instances)
    private static contentCache: Map<string, string> = new Map();
    // Cache: filePath -> revisions array
    private static revisionCache: Map<string, FileRevision[]> = new Map();

    constructor(
        app: App,
        private syncManager: SyncManager,
        private file: TFile,
    ) {
        super(app);
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass("mod-history-modal");

        contentEl.empty();

        // Header row with title and close button
        const headerRow = contentEl.createDiv({ cls: "vault-sync-header-row" });
        headerRow.createEl("h2", {
            text: `${this.syncManager.t("historyTitle")}: ${this.file.name}`,
        });
        const closeBtn = headerRow.createEl("button", {
            cls: "vault-sync-close-btn",
            attr: { "aria-label": "Close" },
        });
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", () => this.close());

        const cachedRevisions = HistoryModal.revisionCache.get(this.file.path);
        if (cachedRevisions) {
            this.revisions = cachedRevisions;
            // Get local content (usually fast)
            this.fileContent = await this.app.vault.read(this.file);
            this.render();
        } else {
            const loadingContainer = contentEl.createDiv({ cls: "vault-sync-loading-container" });
            loadingContainer.createDiv({ cls: "vault-sync-spinner" });
            loadingContainer.createDiv({ text: "Loading history..." });
        }

        try {
            // Load history and local content in parallel for speed
            const [revisions, localContent] = await Promise.all([
                this.syncManager.listRevisions(this.file.path),
                this.app.vault.read(this.file),
            ]);

            // Update cache
            HistoryModal.revisionCache.set(this.file.path, revisions);

            // If data changed or no cache was present, re-render
            const hasChanged =
                !cachedRevisions ||
                revisions.length !== cachedRevisions.length ||
                (revisions.length > 0 && revisions[0].id !== cachedRevisions[0].id);

            if (hasChanged) {
                this.revisions = revisions;
                this.fileContent = localContent;
                this.render();
            }
        } catch (e) {
            contentEl.empty();
            contentEl.createEl("h2", { text: this.syncManager.t("historyError") });
            const errDiv = contentEl.createEl("div", { cls: "error-text" });
            errDiv.setText(
                `${this.syncManager.t("historyFailedToLoadHistory")}: ${e instanceof Error ? e.message : String(e)}`,
            );
            console.error(e);
        }
    }

    render() {
        const { contentEl } = this;

        // Save scroll position before clearing
        const existingList = contentEl.querySelector(".vault-sync-revision-list") as HTMLElement;
        if (existingList) {
            this.listScrollLeft = existingList.scrollLeft;
            this.listScrollTop = existingList.scrollTop;
        }

        contentEl.empty();

        // 1. Reconcile objects with current revisions list (Fix reference mismatch after cache -> fresh update)
        if (this.selectedRevision) {
            const match = this.revisions.find((r) => r.id === this.selectedRevision!.id);
            if (match) this.selectedRevision = match;
        }
        if (this.baseRevision) {
            if (this.baseRevision.id === "empty") {
                // Keep as is
            } else {
                const match = this.revisions.find((r) => r.id === this.baseRevision!.id);
                if (match) this.baseRevision = match;
            }
        }

        // 1. Sort Revisions FIRST (DESC: Newest first)
        this.revisions.sort((a, b) => b.modifiedTime - a.modifiedTime);

        // 2. Auto-select latest revision if none selected
        if (!this.selectedRevision && this.revisions.length > 0) {
            this.selectedRevision = this.revisions[0];
            if (this.revisions.length > 1) {
                this.baseRevision = this.revisions[1];
            } else {
                this.baseRevision = { id: "empty", modifiedTime: 0, size: 0 };
            }
        }

        // Header row with title and close button
        const headerRow = contentEl.createDiv({ cls: "vault-sync-header-row" });
        headerRow.createEl("h2", {
            text: `${this.syncManager.t("historyTitle")}: ${this.file.name}`,
        });

        // Mobile-only: Toggle button for the drawer
        const toggleHistoryBtn = headerRow.createEl("button", {
            cls: "vault-sync-history-toggle-btn",
            attr: { "aria-label": "Toggle History" },
        });
        setIcon(toggleHistoryBtn, "history");
        if (this.isDrawerOpen) {
            toggleHistoryBtn.addClass("is-active");
        }

        toggleHistoryBtn.addEventListener("click", () => {
            this.isDrawerOpen = !this.isDrawerOpen;
            const container = contentEl.querySelector(".vault-sync-history-container");
            if (container) {
                container.toggleClass("is-drawer-open", this.isDrawerOpen);
            }
            toggleHistoryBtn.toggleClass("is-active", this.isDrawerOpen);
        });

        const closeBtn = headerRow.createEl("button", {
            cls: "vault-sync-close-btn",
            attr: { "aria-label": "Close" },
        });
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", () => this.close());

        // --- Container Creation (Grid Layout) ---
        const container = contentEl.createDiv({ cls: "vault-sync-history-container" });
        if (this.isDrawerOpen) {
            container.addClass("is-drawer-open");
        }

        // --- [Area: list] Revision List (Drawer) ---
        const listContainer = container.createDiv({ cls: "vault-sync-history-list" });

        if (this.revisions.length === 0) {
            listContainer.createDiv({
                text: this.syncManager.t("historyNoHistoryFound"),
                cls: "no-history",
            });
        }

        const ul = listContainer.createEl("ul", { cls: "vault-sync-revision-list" });

        let lastDateStr = "";
        for (const rev of this.revisions) {
            const date = new Date(rev.modifiedTime);
            const dateStr = date.toLocaleDateString();
            if (dateStr !== lastDateStr) {
                ul.createEl("li", { cls: "vault-sync-revision-date-header" }).setText(dateStr);
                lastDateStr = dateStr;
            }

            const li = ul.createEl("li", { cls: "vault-sync-revision-item" });
            if (this.selectedRevision?.id === rev.id) {
                li.addClass("is-selected");
            }

            const timeStr = date.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
            const metaDiv = li.createDiv({ cls: "revision-meta" });

            // Row 1: Time and Hash
            const topRow = metaDiv.createDiv({ cls: "revision-top-row" });
            topRow.createSpan({ text: timeStr, cls: "revision-time" });
            if (rev.hash) {
                const hashSpan = topRow.createSpan({
                    text: `#${rev.hash.substring(0, 8)}`,
                    cls: "revision-hash",
                });
                hashSpan.title = rev.hash;
            }

            // Row 2: Author
            const authorDiv = metaDiv.createDiv({ cls: "revision-author" });
            authorDiv.setText(rev.author || this.syncManager.t("historyAuthorUnknown"));

            // Row 3: Size
            const sizeDiv = metaDiv.createDiv({ cls: "revision-size" });
            sizeDiv.style.display = "flex";
            sizeDiv.style.justifyContent = "space-between";
            sizeDiv.createSpan({ text: this.formatSize(rev.size) });

            if (rev.keepForever) {
                const pin = sizeDiv.createSpan({ cls: "revision-pin", text: "📌" });
                pin.title = this.syncManager.t("historyProtectedFromDeletion");
                pin.style.fontSize = "0.9em";
            }

            li.addEventListener("click", () => {
                this.selectedRevision = rev;

                // Reset base to previous relative to the NEW selection
                const idx = this.revisions.indexOf(rev);
                if (idx < this.revisions.length - 1) {
                    this.baseRevision = this.revisions[idx + 1];
                } else {
                    // Oldest revision -> compare with empty
                    this.baseRevision = { id: "empty", modifiedTime: 0, size: 0 };
                }
                this.render(); // Re-render to show diff
            });
        }
        ul.scrollLeft = this.listScrollLeft;
        ul.scrollTop = this.listScrollTop;

        // --- If no selection, show placeholder and return ---
        if (!this.selectedRevision) {
            const placeholder = container.createDiv({ cls: "placeholder-container" });
            placeholder.createDiv({
                text: this.syncManager.t("historySelectRevision"),
                cls: "placeholder-text",
            });
            return;
        }

        // --- [Area: header] Info Header ---
        const infoHeader = container.createDiv({ cls: "vault-sync-info-header" });
        const header = infoHeader.createDiv({ cls: "revision-actions-header" });

        // Row 2: Diff Controls
        const controlRow = header.createDiv({ cls: "revision-control-row" });
        controlRow.style.display = "flex";
        controlRow.style.alignItems = "center";
        controlRow.style.gap = "8px";
        controlRow.style.marginTop = "8px";

        controlRow.createSpan({ text: this.syncManager.t("historyCompareWith") });

        const dropdown = new DropdownComponent(controlRow);
        dropdown.addOption("local", this.syncManager.t("historyCurrentLocalFile"));
        const currentIdx = this.revisions.indexOf(this.selectedRevision);
        if (currentIdx < this.revisions.length - 1) {
            const prev = this.revisions[currentIdx + 1];
            dropdown.addOption(
                prev.id,
                `${this.syncManager.t("historyPreviousVersion")} (${new Date(prev.modifiedTime).toLocaleString()})`,
            );
        } else {
            dropdown.addOption(
                "empty",
                `${this.syncManager.t("historyPreviousVersion")} (${this.syncManager.t("historyInitialEmptyVersion")})`,
            );
        }
        this.revisions.forEach((r) => {
            if (r.id === this.selectedRevision?.id) return;
            if (
                currentIdx < this.revisions.length - 1 &&
                r.id === this.revisions[currentIdx + 1].id
            )
                return;
            dropdown.addOption(
                r.id,
                `${new Date(r.modifiedTime).toLocaleString()} (${r.author || this.syncManager.t("historyAuthorUnknown")})`,
            );
        });
        if (this.baseRevision) {
            dropdown.setValue(this.baseRevision.id);
        } else {
            dropdown.setValue("local");
        }
        dropdown.onChange((val) => {
            if (val === "local") {
                this.baseRevision = null;
            } else if (val === "empty") {
                this.baseRevision = { id: "empty", modifiedTime: 0, size: 0 };
            } else {
                this.baseRevision = this.revisions.find((r) => r.id === val) || null;
            }
            this.render(); // Re-render diff
        });

        // Toggle View Mode
        const modeBtn = new ExtraButtonComponent(controlRow)
            .setIcon(this.diffMode === "unified" ? "rows" : "columns")
            .setTooltip(
                this.diffMode === "unified"
                    ? this.syncManager.t("historyDiffModeUnified")
                    : this.syncManager.t("historyDiffModeSplit"),
            )
            .onClick(() => {
                this.diffMode = this.diffMode === "unified" ? "split" : "unified";
                this.render();
            });
        modeBtn.extraSettingsEl.addClass("diff-mode-toggle");
        if (this.diffMode === "split") {
            modeBtn.extraSettingsEl.addClass("is-active");
        }

        // Menu Button
        const menuBtn = new ExtraButtonComponent(controlRow)
            .setIcon("vertical-three-dots")
            .setTooltip(this.syncManager.t("historyActions"))
            .onClick(() => {
                const menu = new Menu();
                // Keep Forever Toggle
                menu.addItem((item) => {
                    item.setTitle(this.syncManager.t("historyKeepForever"))
                        .setIcon(this.selectedRevision!.keepForever ? "check-square" : "square")
                        .onClick(async () => {
                            const newVal = !this.selectedRevision!.keepForever;

                            // Warn before enabling, as it cannot be undone for past revisions
                            if (newVal) {
                                const confirmed = window.confirm(
                                    this.syncManager.t("historyKeepForeverConfirm"),
                                );
                                if (!confirmed) return;
                            }

                            try {
                                this.selectedRevision!.keepForever = newVal;
                                await this.syncManager.setRevisionKeepForever(
                                    this.file.path,
                                    this.selectedRevision!.id,
                                    newVal,
                                );
                                await this.syncManager.notify(
                                    `${this.syncManager.t("noticeSavedKeepForever")}: ${newVal}`,
                                );
                                this.render();
                            } catch (err: any) {
                                const msg = err instanceof Error ? err.message : String(err);
                                if (
                                    msg.includes("illegalKeepForeverModification") ||
                                    msg.includes("Cannot update a revision to false")
                                ) {
                                    await this.syncManager.notify(
                                        this.syncManager.t("historyKeepForeverError"),
                                    );
                                } else {
                                    await this.syncManager.notify(
                                        `${this.syncManager.t("noticeFailedToSave")}: ${err}`,
                                    );
                                }
                                this.selectedRevision!.keepForever = !newVal; // Revert
                                this.render();
                            }
                        });
                });
                menu.addSeparator();

                // Restore As
                menu.addItem((item) => {
                    item.setTitle(this.syncManager.t("historyRestoreAs"))
                        .setIcon("copy")
                        .onClick(async () => {
                            const ext = this.file.extension;
                            const baseName = this.file.path.substring(
                                0,
                                this.file.path.lastIndexOf("."),
                            );
                            const defaultPath = `${baseName}_restored.${ext}`;
                            const prompt = new PromptModal(
                                this.app,
                                this.syncManager.t("historyRestoreAsTitle"),
                                defaultPath,
                                async (newPath) => {
                                    if (newPath) {
                                        try {
                                            const buffer =
                                                await this.syncManager.getRevisionContent(
                                                    this.file.path,
                                                    this.selectedRevision!.id,
                                                );
                                            await this.app.vault.createBinary(newPath, buffer);
                                            await this.syncManager.notify(
                                                this.syncManager
                                                    .t("noticeHistoryRestoreAs")
                                                    .replace("{0}", newPath),
                                            );
                                        } catch (err) {
                                            await this.syncManager.notify(
                                                `${this.syncManager.t("noticeFailedToSave")}: ${err}`,
                                            );
                                        }
                                    }
                                },
                                async (val) => {
                                    if (!val) return null;
                                    const exists = await this.app.vault.adapter.exists(val);
                                    if (exists) {
                                        return this.syncManager.t("historyRestoreAsErrorExists");
                                    }
                                    return null;
                                },
                            );
                            prompt.open();
                        });
                });

                // Restore
                menu.addItem((item) => {
                    item.setTitle(this.syncManager.t("historyRestoreVersion"))
                        .setIcon("rotate-ccw")
                        .setWarning(true)
                        .onClick(async () => {
                            const dateStr = new Date(
                                this.selectedRevision!.modifiedTime,
                            ).toLocaleString();
                            const confirmed = window.confirm(
                                this.syncManager.t("historyRestoreConfirm").replace("{0}", dateStr),
                            );
                            if (confirmed) {
                                this.close();
                                await this.syncManager.restoreRevision(
                                    this.file.path,
                                    this.selectedRevision!,
                                );
                            }
                        });
                });

                menu.addSeparator();

                // Delete Revision
                menu.addItem((item) => {
                    item.setTitle(this.syncManager.t("historyDeleteRevision"))
                        .setIcon("trash")
                        .setWarning(true)
                        .onClick(async () => {
                            const dateStr = new Date(
                                this.selectedRevision!.modifiedTime,
                            ).toLocaleString();
                            const confirmed = window.confirm(
                                this.syncManager.t("historyDeleteConfirm").replace("{0}", dateStr),
                            );
                            if (!confirmed) return;

                            try {
                                await this.syncManager.deleteRevision(
                                    this.file.path,
                                    this.selectedRevision!.id,
                                );
                                await this.syncManager.notify(
                                    this.syncManager.t("noticeRevisionDeleted"),
                                );

                                // Remove from local list and update cache
                                this.revisions = this.revisions.filter(
                                    (r) => r.id !== this.selectedRevision!.id,
                                );
                                HistoryModal.revisionCache.set(this.file.path, this.revisions);

                                // Select another revision if available
                                if (this.revisions.length > 0) {
                                    this.selectedRevision = this.revisions[0];
                                    // Reset base to previous relative to the NEW selection
                                    const idx = 0;
                                    if (idx < this.revisions.length - 1) {
                                        this.baseRevision = this.revisions[idx + 1];
                                    } else {
                                        this.baseRevision = {
                                            id: "empty",
                                            modifiedTime: 0,
                                            size: 0,
                                        };
                                    }
                                } else {
                                    this.selectedRevision = null;
                                    this.baseRevision = null;
                                }

                                this.render();
                            } catch (err) {
                                await this.syncManager.notify(
                                    `${this.syncManager.t("noticeFailedToSave")}: ${err}`,
                                );
                            }
                        });
                });
                const rect = menuBtn.extraSettingsEl.getBoundingClientRect();
                menu.showAtPosition({
                    x: rect.right,
                    y: rect.bottom,
                });
                // Hack: Left-shift the menu
                const menus = document.body.querySelectorAll(".menu");
                const latestMenu = menus[menus.length - 1] as HTMLElement;
                if (latestMenu) {
                    const menuWidth = latestMenu.offsetWidth;
                    latestMenu.style.left = `${rect.right - menuWidth}px`;
                }
            });

        // --- [Area: diff] Diff View ---
        const diffContainer = container.createDiv({ cls: "revision-diff-view" });
        diffContainer.createDiv({ text: "Loading diff...", cls: "loading-text" });
        this.loadDiff(diffContainer, this.selectedRevision, this.baseRevision);
    }

    async loadDiff(
        container: HTMLElement,
        targetRevision: FileRevision,
        baseRevision: FileRevision | null,
    ) {
        const isCached = (revId: string) =>
            revId === "empty" || HistoryModal.contentCache.has(revId);
        const bothCached =
            isCached(targetRevision.id) && (!baseRevision || isCached(baseRevision.id));

        if (!bothCached) {
            // Show loading spinner in the diff area ONLY if not cached
            container.empty();
            const loadingContainer = container.createDiv({ cls: "vault-sync-loading-container" });
            loadingContainer.createDiv({ cls: "vault-sync-spinner" });
            loadingContainer.createDiv({ text: "Loading diff..." });
        }

        try {
            // [Reliability] Size limit check (e.g. 2MB)
            if (targetRevision.size > 2 * 1024 * 1024) {
                container.empty();
                container.createDiv({
                    text: "File is too large to display diff (>2MB). Restore to view content.",
                    cls: "warning-text",
                });
                return;
            }

            const fetchContent = async (revId: string): Promise<string> => {
                if (revId === "empty") return "";
                let content = HistoryModal.contentCache.get(revId);
                if (!content) {
                    const buffer = await this.syncManager.getRevisionContent(this.file.path, revId);
                    content = new TextDecoder().decode(buffer);
                    HistoryModal.contentCache.set(revId, content);
                }
                return content;
            };

            // Fetch target and base content in parallel
            const [targetContent, baseContent] = await Promise.all([
                fetchContent(targetRevision.id),
                baseRevision
                    ? fetchContent(baseRevision.id)
                    : Promise.resolve(this.fileContent || ""),
            ]);

            container.empty();

            // Diff: Base -> Target
            const dmp = new diff_match_patch();
            const diffs = dmp.diff_main(baseContent, targetContent);
            dmp.diff_cleanupSemantic(diffs);

            if (this.diffMode === "unified") {
                this.renderLineDiff(container, diffs, true);
            } else {
                // Split View
                container.style.display = "flex";
                container.style.gap = "0";
                container.style.padding = "0";

                const leftPane = container.createDiv({ cls: "diff-pane diff-pane-left" });
                const rightPane = container.createDiv({ cls: "diff-pane diff-pane-right" });

                const leftDiffs = diffs.filter(([op]) => op !== 1);
                const rightDiffs = diffs.filter(([op]) => op !== -1);

                this.renderLineDiff(leftPane, leftDiffs, true);
                this.renderLineDiff(rightPane, rightDiffs, true);
            }
        } catch (e) {
            container.empty();
            container.createDiv({
                text: `${this.syncManager.t("historyError")}: ${e instanceof Error ? e.message : String(e)}`,
                cls: "error-text",
            });
            console.error(e);
        }
    }

    /**
     * Helper to render diffs as a vertical list of lines with line numbers
     */
    private renderLineDiff(container: HTMLElement, diffs: [number, string][], showLineNo: boolean) {
        let lineNo = 1;
        let lineDiv = container.createDiv({ cls: "diff-line" });
        if (showLineNo) lineDiv.createDiv({ cls: "diff-line-number", text: String(lineNo++) });
        let contentDiv = lineDiv.createDiv({ cls: "diff-line-content" });

        diffs.forEach(([op, text]) => {
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (i > 0) {
                    lineDiv = container.createDiv({ cls: "diff-line" });
                    if (showLineNo)
                        lineDiv.createDiv({ cls: "diff-line-number", text: String(lineNo++) });
                    contentDiv = lineDiv.createDiv({ cls: "diff-line-content" });
                }

                if (lines[i]) {
                    const colorClass =
                        op === 1 ? "diff-added" : op === -1 ? "diff-removed" : "diff-neutral";
                    const span = contentDiv.createSpan({ cls: colorClass });
                    span.setText(lines[i]);
                }
            }
        });
    }
    formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
