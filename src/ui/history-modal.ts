import {
    App,
    Modal,
    TFile,
    ButtonComponent,
    setIcon,
    DropdownComponent,
    ExtraButtonComponent,
    Menu,
    TextComponent,
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
    private showAllLines: boolean = true;
    private contextLines: number = 3;
    private diffBlocks: HTMLElement[][] = [];
    private currentDiffIndex: number = -1;
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
        this.syncManager.currentTrigger = "history-modal";
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

        // Spacer to push subsequent buttons to the right
        controlRow.createSpan({ cls: "vault-sync-control-spacer" }).style.flex = "1";

        // 1. Context Lines Input (Only if not showing all)
        if (!this.showAllLines) {
            const contextGroup = controlRow.createDiv({ cls: "diff-control-group" });
            contextGroup.createSpan({
                text: this.syncManager.t("historyContextLines").replace("{0}", ""),
            });
            const contextInput = new TextComponent(contextGroup)
                .setValue(String(this.contextLines))
                .onChange((val) => {
                    const num = parseInt(val);
                    if (!isNaN(num) && num >= 0) {
                        this.contextLines = num;
                        // Surgical update: Only refresh the diff area to keep focus
                        const diffView = this.contentEl.querySelector(
                            ".revision-diff-view",
                        ) as HTMLElement;
                        if (diffView && this.selectedRevision) {
                            this.loadDiff(diffView, this.selectedRevision, this.baseRevision);
                        }
                    }
                });
            contextInput.inputEl.addClass("diff-context-input");
            contextInput.inputEl.type = "number";
            contextInput.inputEl.min = "0";
        }

        // 2. Toggle Show All / Diff Only
        new ExtraButtonComponent(controlRow)
            .setIcon(this.showAllLines ? "eye" : "eye-off")
            .setTooltip(
                this.showAllLines
                    ? this.syncManager.t("historyShowDiffOnly")
                    : this.syncManager.t("historyShowAll"),
            )
            .onClick(() => {
                this.showAllLines = !this.showAllLines;
                this.render();
            })
            .extraSettingsEl.toggleClass("is-active", !this.showAllLines);

        // 3. Jump Buttons (Prev / Next)
        new ExtraButtonComponent(controlRow)
            .setIcon("chevron-up")
            .setTooltip(this.syncManager.t("historyPrevDiff"))
            .onClick(() => this.jumpToDiff(-1));

        new ExtraButtonComponent(controlRow)
            .setIcon("chevron-down")
            .setTooltip(this.syncManager.t("historyNextDiff"))
            .onClick(() => this.jumpToDiff(1));

        // 4. Toggle View Mode (Split / Unified)
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

        // 5. Menu Button
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
                                await this.syncManager.notify("noticeSavedKeepForever", String(newVal));
                                this.render();
                            } catch (err: any) {
                                const msg = err instanceof Error ? err.message : String(err);
                                if (
                                    msg.includes("illegalKeepForeverModification") ||
                                    msg.includes("Cannot update a revision to false")
                                ) {
                                    await this.syncManager.notify("historyKeepForeverError");
                                } else {
                                    await this.syncManager.notify("noticeFailedToSave", String(err));
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
                                            await this.syncManager.notify("noticeHistoryRestoreAs", newPath);
                                        } catch (err) {
                                            await this.syncManager.notify("noticeFailedToSave", String(err));
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
                                await this.syncManager.notify("noticeRevisionDeleted");

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
                                await this.syncManager.notify("noticeFailedToSave", String(err));
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

            const lines = this.processDiffToLines(diffs);

            // Validation: context lines cannot exceed max file lines
            if (this.contextLines > lines.length) {
                this.contextLines = lines.length;
            }

            container.empty();
            const table = container.createDiv({ cls: "diff-table" });
            this.diffBlocks = [];
            this.currentDiffIndex = -1;

            let currentOmitted = false;
            let currentBlock: HTMLElement[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Check if line should be displayed
                let shouldShow = this.showAllLines;
                if (!shouldShow) {
                    // Check neighbors within contextLines
                    for (let j = i - this.contextLines; j <= i + this.contextLines; j++) {
                        if (lines[j] && lines[j].isDiff) {
                            shouldShow = true;
                            break;
                        }
                    }
                }

                if (shouldShow) {
                    if (currentOmitted) {
                        table.createDiv({ cls: "diff-gap", text: "..." });
                        currentOmitted = false;
                    }
                    const row = this.renderDiffRow(table, line);
                    if (line.isDiff) {
                        if (line.isStartOfBlock) {
                            if (currentBlock.length > 0) this.diffBlocks.push(currentBlock);
                            currentBlock = [row];
                        } else {
                            currentBlock.push(row);
                        }
                    } else {
                        if (currentBlock.length > 0) {
                            this.diffBlocks.push(currentBlock);
                            currentBlock = [];
                        }
                    }
                } else {
                    currentOmitted = true;
                    if (currentBlock.length > 0) {
                        this.diffBlocks.push(currentBlock);
                        currentBlock = [];
                    }
                }
            }
            if (currentBlock.length > 0) this.diffBlocks.push(currentBlock);

            // Auto-highlight first diff
            if (this.diffBlocks.length > 0) {
                setTimeout(() => this.jumpToDiff(0), 50);
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

    private jumpToDiff(direction: number) {
        if (this.diffBlocks.length === 0) return;

        if (direction === 0) {
            this.currentDiffIndex = 0;
        } else {
            // Cycle/Wrap around navigation
            this.currentDiffIndex =
                (this.currentDiffIndex + direction + this.diffBlocks.length) %
                this.diffBlocks.length;
        }

        const targetBlock = this.diffBlocks[this.currentDiffIndex];
        if (targetBlock && targetBlock.length > 0) {
            // Remove previous highlights
            this.diffBlocks.flat().forEach((b) => {
                b.removeClass("is-highlighted");
                b.removeClass("is-highlighted-start");
                b.removeClass("is-highlighted-end");
            });

            // Highlight all rows in the block with start/end styling
            targetBlock.forEach((row, idx) => {
                row.addClass("is-highlighted");
                if (idx === 0) row.addClass("is-highlighted-start");
                if (idx === targetBlock.length - 1) row.addClass("is-highlighted-end");
            });

            // Scroll to the first row of the block
            targetBlock[0].scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    private processDiffToLines(diffs: [number, string][]) {
        interface Row {
            segments: { op: number; text: string }[];
            lNo?: number;
            rNo?: number;
            isDiff: boolean;
            isStartOfBlock?: boolean;
        }

        const rows: Row[] = [];
        let cur: Row = { segments: [], isDiff: false };

        diffs.forEach(([op, text]) => {
            const parts = text.split("\n");
            parts.forEach((part, i) => {
                if (i > 0) {
                    rows.push(cur);
                    cur = { segments: [], isDiff: false };
                }
                if (part || i < parts.length - 1) {
                    cur.segments.push({ op, text: part });
                    if (op !== 0) cur.isDiff = true;
                }
            });
        });
        if (cur.segments.length > 0) rows.push(cur);

        let lNo = 1;
        let rNo = 1;
        let inDiffBlock = false;

        rows.forEach((row) => {
            const hasLeft = row.segments.some((s) => s.op <= 0);
            const hasRight = row.segments.some((s) => s.op >= 0);
            if (hasLeft) row.lNo = lNo++;
            if (hasRight) row.rNo = rNo++;

            if (row.isDiff) {
                if (!inDiffBlock) {
                    row.isStartOfBlock = true;
                    inDiffBlock = true;
                }
            } else {
                inDiffBlock = false;
            }
        });

        return rows;
    }

    private renderDiffRow(container: HTMLElement, row: any) {
        const rowEl = container.createDiv({
            cls: `diff-row diff-row-${this.diffMode}`,
        });

        if (this.diffMode === "unified") {
            const cell = rowEl.createDiv({ cls: "diff-cell" });

            // Determine row color
            const ops = new Set(row.segments.map((s: any) => s.op));
            if (ops.has(1) && !ops.has(-1)) rowEl.addClass("diff-op-added");
            else if (ops.has(-1) && !ops.has(1)) rowEl.addClass("diff-op-removed");
            else if (ops.has(1) || ops.has(-1)) rowEl.addClass("diff-op-modified");

            cell.createDiv({ cls: "diff-ln", text: String(row.lNo || "") });
            cell.createDiv({ cls: "diff-ln", text: String(row.rNo || "") });
            const content = cell.createDiv({ cls: "diff-cn" });

            row.segments.forEach((seg: any) => {
                const s = content.createSpan({ text: seg.text });
                if (seg.op === 1) s.addClass("diff-added-inline");
                if (seg.op === -1) s.addClass("diff-removed-inline");
            });
        } else {
            // Split View
            const leftCell = rowEl.createDiv({ cls: "diff-cell diff-cell-left" });
            const rightCell = rowEl.createDiv({ cls: "diff-cell diff-cell-right" });

            const leftSegments = row.segments.filter((s: any) => s.op <= 0);
            const rightSegments = row.segments.filter((s: any) => s.op >= 0);

            // Left Side
            if (leftSegments.length > 0) {
                const hasRemoved = leftSegments.some((s: any) => s.op === -1);
                if (hasRemoved && !rightSegments.some((s: any) => s.op === 1)) {
                    leftCell.addClass("diff-op-removed");
                } else if (hasRemoved) {
                    leftCell.addClass("diff-op-modified");
                }
                leftCell.createDiv({ cls: "diff-ln", text: String(row.lNo || "") });
                const content = leftCell.createDiv({ cls: "diff-cn" });
                leftSegments.forEach((seg: any) => {
                    const s = content.createSpan({ text: seg.text });
                    if (seg.op === -1) s.addClass("diff-removed-inline");
                });
            } else {
                leftCell.addClass("diff-op-spacer");
                leftCell.createDiv({ cls: "diff-ln", text: "" });
                leftCell.createDiv({ cls: "diff-cn", text: "" });
            }

            // Right Side
            if (rightSegments.length > 0) {
                const hasAdded = rightSegments.some((s: any) => s.op === 1);
                if (hasAdded && !leftSegments.some((s: any) => s.op === -1)) {
                    rightCell.addClass("diff-op-added");
                } else if (hasAdded) {
                    rightCell.addClass("diff-op-modified");
                }
                rightCell.createDiv({ cls: "diff-ln", text: String(row.rNo || "") });
                const content = rightCell.createDiv({ cls: "diff-cn" });
                rightSegments.forEach((seg: any) => {
                    const s = content.createSpan({ text: seg.text });
                    if (seg.op === 1) s.addClass("diff-added-inline");
                });
            } else {
                rightCell.addClass("diff-op-spacer");
                rightCell.createDiv({ cls: "diff-ln", text: "" });
                rightCell.createDiv({ cls: "diff-cn", text: "" });
            }
        }
        return rowEl;
    }

    private renderLineDiff(container: HTMLElement, diffs: [number, string][], showLineNo: boolean) {
        // Obsolete but kept for signature compatibility if needed
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
