import {
    App,
    Modal,
    TFile,
    Notice,
    ButtonComponent,
    setIcon,
    DropdownComponent,
    ExtraButtonComponent,
    Menu,
} from "obsidian";
import { SyncManager } from "../sync-manager";
import { FileRevision } from "../types/adapter";
import { diff_match_patch } from "diff-match-patch";

export class HistoryModal extends Modal {
    private revisions: FileRevision[] = [];
    private selectedRevision: FileRevision | null = null;
    private baseRevision: FileRevision | null = null; // null means Local File
    private fileContent: string | null = null; // Current local content for diff
    private listScrollLeft: number = 0; // Preserve horizontal scroll position

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

        contentEl.createEl("div", { text: "Loading history from cloud..." });

        try {
            // Load history
            // Use the syncManager wrapper which ensures adapter support
            this.revisions = await this.syncManager.listRevisions(this.file.path);

            // Read local content for diff (text files only)
            // Ideally we check extension or mime type, but for now assuming text if opened in Obsidian
            this.fileContent = await this.app.vault.read(this.file);

            this.render();
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
        const existingList = contentEl.querySelector(".vault-sync-revision-list");
        if (existingList) {
            this.listScrollLeft = existingList.scrollLeft;
        }

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

        const container = contentEl.createDiv({ cls: "vault-sync-history-container" });

        // Left: Revision List
        const listContainer = container.createDiv({ cls: "vault-sync-history-list" });
        listContainer.createEl("h3", { text: this.syncManager.t("historyRevisions") });

        if (this.revisions.length === 0) {
            listContainer.createDiv({ text: this.syncManager.t("historyNoHistoryFound") });
        }

        const ul = listContainer.createEl("ul", { cls: "vault-sync-revision-list" });
        // Sort DESC (Newest first)
        this.revisions.sort((a, b) => b.modifiedTime - a.modifiedTime);

        for (const rev of this.revisions) {
            const li = ul.createEl("li", { cls: "vault-sync-revision-item" });
            if (this.selectedRevision?.id === rev.id) {
                li.addClass("is-selected");
            }

            const dateStr = new Date(rev.modifiedTime).toLocaleString();
            const metaDiv = li.createDiv({ cls: "revision-meta" });

            const dateSpan = metaDiv.createSpan({ cls: "revision-date" });
            dateSpan.setText(dateStr);

            if (rev.keepForever) {
                const pin = metaDiv.createSpan({ cls: "revision-pin", text: " 📌" });
                pin.title = this.syncManager.t("historyProtectedFromDeletion");
            }

            if (rev.author) {
                metaDiv.createDiv({
                    text: `${this.syncManager.t("historyByAuthor")} ${rev.author}`,
                    cls: "revision-author",
                });
            }
            metaDiv.createDiv({ text: this.formatSize(rev.size), cls: "revision-size" });

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

        // Restore scroll position after list is built
        ul.scrollLeft = this.listScrollLeft;

        // Right: Diff / Actions
        const detailContainer = container.createDiv({ cls: "vault-sync-history-detail" });

        if (!this.selectedRevision) {
            detailContainer.createDiv({
                text: this.syncManager.t("historySelectRevision"),
                cls: "placeholder-text",
            });
            return;
        }

        // Actions Header
        const header = detailContainer.createDiv({ cls: "revision-actions-header" });

        // Row 1: Title & Menu
        const titleRow = header.createDiv({ cls: "revision-title-row" });
        titleRow.style.display = "flex";
        titleRow.style.justifyContent = "space-between";
        titleRow.style.alignItems = "center";

        const detailsTitle = titleRow.createEl("h3");
        detailsTitle.setText(
            `${this.syncManager.t("historyRevisionLabel")}: ${new Date(this.selectedRevision.modifiedTime).toLocaleString()}`,
        );
        detailsTitle.style.margin = "0";

        // Menu Button
        const menuBtn = new ExtraButtonComponent(titleRow)
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
                            try {
                                this.selectedRevision!.keepForever = newVal;
                                await this.syncManager.setRevisionKeepForever(
                                    this.file.path,
                                    this.selectedRevision!.id,
                                    newVal,
                                );
                                new Notice(
                                    `${this.syncManager.t("noticeSavedKeepForever")}: ${newVal}`,
                                );
                                this.render();
                            } catch (err) {
                                new Notice(`${this.syncManager.t("noticeFailedToSave")}: ${err}`);
                                this.selectedRevision!.keepForever = !newVal; // Revert
                                this.render();
                            }
                        });
                });

                menu.addSeparator();

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

                const rect = menuBtn.extraSettingsEl.getBoundingClientRect();
                menu.showAtPosition({
                    x: rect.right,
                    y: rect.bottom,
                });

                // Hack: Left-shift the menu to align right edges
                // Execute synchronously to avoid flicker (hopes that showAtPosition appends to DOM synchronously)
                const menus = document.body.querySelectorAll(".menu");
                const latestMenu = menus[menus.length - 1] as HTMLElement;
                if (latestMenu) {
                    const menuWidth = latestMenu.offsetWidth;
                    // Determine overlap: currently x is at rect.right (menu's left edge)
                    // We want menu's right edge to be at rect.right
                    // So new left = rect.right - menuWidth
                    latestMenu.style.left = `${rect.right - menuWidth}px`;
                }
            });

        // Row 2: Diff Controls
        const controlRow = header.createDiv({ cls: "revision-control-row" });
        controlRow.style.display = "flex";
        controlRow.style.alignItems = "center";
        controlRow.style.gap = "8px";
        controlRow.style.marginTop = "8px";

        controlRow.createSpan({ text: this.syncManager.t("historyCompareWith") });

        const dropdown = new DropdownComponent(controlRow);

        // Option: Local File
        dropdown.addOption("local", this.syncManager.t("historyCurrentLocalFile"));

        // Option: Previous Revision (if exists)
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

        // Separator logic is hard in standard dropdown, just list others
        // We can add "Select specific..." placeholder logic or just list top 5?
        // Let's list all for now, but mark them.
        this.revisions.forEach((r) => {
            if (r.id === this.selectedRevision?.id) return; // Don't compare with self
            // Skip if already added as "Previous"
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

        // Set value
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

        // Diff View
        const diffContainer = detailContainer.createDiv({ cls: "revision-diff-view" });
        diffContainer.createDiv({ text: "Loading diff...", cls: "loading-text" });

        // Async load content and diff
        this.loadDiff(diffContainer, this.selectedRevision, this.baseRevision);
    }

    // Cache: revisionId -> content string
    private contentCache: Map<string, string> = new Map();

    async loadDiff(
        container: HTMLElement,
        targetRevision: FileRevision,
        baseRevision: FileRevision | null,
    ) {
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

            // Get Target Content (The selected revision - usually NEW side)
            let targetContent = this.contentCache.get(targetRevision.id);
            if (!targetContent) {
                const buffer = await this.syncManager.getRevisionContent(
                    this.file.path,
                    targetRevision.id,
                );
                const decoder = new TextDecoder();
                targetContent = decoder.decode(buffer);
                this.contentCache.set(targetRevision.id, targetContent);
            }

            // Get Base Content (The comparison base - usually OLD side)
            let baseContent = "";
            if (baseRevision) {
                if (baseRevision.id === "empty") {
                    baseContent = "";
                } else {
                    let cachedBase = this.contentCache.get(baseRevision.id);
                    if (!cachedBase) {
                        const buffer = await this.syncManager.getRevisionContent(
                            this.file.path,
                            baseRevision.id,
                        );
                        const decoder = new TextDecoder();
                        cachedBase = decoder.decode(buffer);
                        this.contentCache.set(baseRevision.id, cachedBase);
                    }
                    baseContent = cachedBase;
                }
            } else {
                // Local file
                baseContent = this.fileContent || "";
            }

            container.empty();

            // Diff: Base -> Target
            // Added (Green): In Target, not in Base
            // Removed (Red): In Base, not in Target
            const dmp = new diff_match_patch();
            const diffs = dmp.diff_main(baseContent, targetContent);
            dmp.diff_cleanupSemantic(diffs);

            diffs.forEach((part) => {
                const op = part[0]; // 0: equal, 1: insert, -1: delete
                const text = part[1];

                const colorClass =
                    op === 1 ? "diff-added" : op === -1 ? "diff-removed" : "diff-neutral";

                const span = container.createEl("span", { cls: colorClass });
                span.setText(text);
            });
        } catch (e) {
            container.empty();
            container.createDiv({
                text: `Failed to load content for diff: ${e}`,
                cls: "error-text",
            });
        }
    }

    formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.contentCache.clear();
    }
}
