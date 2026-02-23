import { App, Modal, setIcon, ButtonComponent, TextComponent } from "obsidian";
import type VaultSync from "../main";
import type { VaultSyncSettings } from "../types/settings";
import { t } from "../i18n";
import { matchWildcard } from "../utils/wildcard";

interface ToggleExclusion {
    settingKey: keyof VaultSyncSettings;
    label: string;
    patterns: string[];
}

const TOGGLE_EXCLUSIONS: ToggleExclusion[] = [
    {
        settingKey: "syncCoreConfig",
        label: "settingSyncCoreConfig",
        patterns: [
            ".obsidian/app.json",
            ".obsidian/appearance.json",
            ".obsidian/hotkeys.json",
            ".obsidian/core-plugins.json",
            ".obsidian/community-plugins.json",
            ".obsidian/graph.json",
        ],
    },
    {
        settingKey: "syncCommunityPlugins",
        label: "settingSyncCommunityPlugins",
        patterns: [".obsidian/plugins/**"],
    },
    {
        settingKey: "syncAppearance",
        label: "settingSyncAppearance",
        patterns: [".obsidian/themes/**", ".obsidian/snippets/**"],
    },
    {
        settingKey: "syncWorkspace",
        label: "settingSyncWorkspace",
        patterns: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json"],
    },
    {
        settingKey: "syncImagesAndMedia",
        label: "settingSyncImagesAndMedia",
        patterns: ["*.png, *.jpg, *.gif, *.svg, *.webp, *.mp3, *.mp4, ..."],
    },
    {
        settingKey: "syncDotfiles",
        label: "settingSyncDotfiles",
        patterns: [".*"],
    },
    {
        settingKey: "syncFlexibleData",
        label: "settingSyncFlexibleData",
        patterns: [".obsidian/plugins/obsidian-vault-sync/data/flexible/**"],
    },
    {
        settingKey: "syncDeviceLogs",
        label: "settingSyncDeviceLogs",
        patterns: [".obsidian/plugins/obsidian-vault-sync/logs/**"],
    },
];

export class ExclusionPatternModal extends Modal {
    private plugin: VaultSync;
    private patterns: string[];
    private listEl!: HTMLElement;
    private statusEl!: HTMLElement;
    private inputComp!: TextComponent;
    private suggestEl!: HTMLElement;
    private errorEl!: HTMLElement;
    private allPaths: string[] = [];
    private allFolders: string[] = [];
    private expandedPatterns: Set<string> = new Set();
    private pathsLoaded = false;

    constructor(app: App, plugin: VaultSync) {
        super(app);
        this.plugin = plugin;
        this.patterns = (plugin.settings.exclusionPatterns || "")
            .split("\n")
            .map((p) => p.trim())
            .filter((p) => p);
    }

    onOpen(): void {
        const { contentEl } = this;
        this.modalEl.addClass("vault-sync-exclusion-modal");
        contentEl.empty();

        contentEl.createEl("h2", { text: t("settingExclusionModalTitle") });

        const addRow = contentEl.createDiv({ cls: "vault-sync-exclusion-add-row" });

        this.inputComp = new TextComponent(addRow);
        this.inputComp.setPlaceholder(t("settingExclusionModalPlaceholder"));
        this.inputComp.inputEl.addClass("vault-sync-exclusion-add-input");
        this.inputComp.inputEl.addEventListener("input", () => this.onInputChange());
        this.inputComp.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.addCurrentPattern();
            } else if (e.key === "Escape") {
                this.hideSuggest();
            }
        });

        new ButtonComponent(addRow)
            .setButtonText("+")
            .setCta()
            .onClick(() => this.addCurrentPattern());

        // Suggest dropdown
        this.suggestEl = addRow.createDiv({ cls: "vault-sync-exclusion-suggest" });
        this.suggestEl.style.display = "none";

        // Error message
        this.errorEl = contentEl.createDiv({ cls: "vault-sync-exclusion-error" });
        this.errorEl.style.display = "none";

        // Pattern list (below the input)
        this.listEl = contentEl.createDiv({ cls: "vault-sync-exclusion-list" });

        // Status line (bottom)
        this.statusEl = contentEl.createDiv({ cls: "vault-sync-exclusion-status" });

        // Close suggest on outside click
        contentEl.addEventListener("click", (e) => {
            if (!addRow.contains(e.target as Node)) {
                this.hideSuggest();
            }
        });

        // Show scanning status while loading paths
        this.updateStatus();

        // Load all file paths, then render once ready
        this.loadAllPaths().then(() => {
            this.pathsLoaded = true;
            this.renderList();
        });
    }

    private async loadAllPaths(): Promise<void> {
        const paths = new Set<string>();
        const folders = new Set<string>();

        // Vault content files
        for (const f of this.app.vault.getFiles()) {
            paths.add(f.path);
        }

        // Extract folders from vault files
        for (const f of this.app.vault.getAllLoadedFiles()) {
            if ("children" in f && f.path) {
                folders.add(f.path);
            }
        }

        // .obsidian directory files via adapter (async)
        await this.listRecursive(".obsidian", paths, folders);

        this.allPaths = Array.from(paths).sort();
        this.allFolders = Array.from(folders).sort();
    }

    private async listRecursive(
        dirPath: string,
        paths: Set<string>,
        folders: Set<string>,
    ): Promise<void> {
        try {
            const listing = await this.app.vault.adapter.list(dirPath);
            folders.add(dirPath);
            for (const file of listing.files) {
                paths.add(file);
            }
            for (const folder of listing.folders) {
                await this.listRecursive(folder, paths, folders);
            }
        } catch {
            // Directory doesn't exist or can't be read
        }
    }

    private renderList(): void {
        this.listEl.empty();

        // User-defined patterns
        this.renderUserPatterns();

        // Toggle-managed exclusions (show disabled toggles)
        this.renderToggleExclusions();

        this.updateStatus();
    }

    private renderUserPatterns(): void {
        if (this.patterns.length === 0 && this.getActiveToggleExclusions().length === 0) {
            this.listEl.createDiv({
                cls: "vault-sync-exclusion-empty",
                text: t("settingExclusionModalEmpty"),
            });
            return;
        }

        for (let i = 0; i < this.patterns.length; i++) {
            const pattern = this.patterns[i];
            const itemContainer = this.listEl.createDiv({
                cls: "vault-sync-exclusion-item-container",
            });
            const item = itemContainer.createDiv({ cls: "vault-sync-exclusion-item" });

            // Selectable pattern text
            const patternEl = item.createSpan({
                cls: "vault-sync-exclusion-item-pattern",
                text: pattern,
            });
            patternEl.setAttribute("title", pattern);

            // Match count (clickable) — only show counts after paths are loaded
            if (this.pathsLoaded) {
                const matchedFiles = this.getMatchedFiles(pattern);
                const matchCount = matchedFiles.length;
                const matchEl = item.createDiv({
                    cls: "vault-sync-exclusion-match-count",
                    text: t("settingExclusionModalMatchCount").replace("{0}", String(matchCount)),
                });

                if (matchCount > 0) {
                    matchEl.addClass("vault-sync-exclusion-match-clickable");
                    matchEl.addEventListener("click", (e) => {
                        e.stopPropagation();
                        if (this.expandedPatterns.has(pattern)) {
                            this.expandedPatterns.delete(pattern);
                        } else {
                            this.expandedPatterns.add(pattern);
                        }
                        this.renderList();
                    });
                }

                // Expanded file list
                if (this.expandedPatterns.has(pattern) && matchCount > 0) {
                    const fileListEl = itemContainer.createDiv({
                        cls: "vault-sync-exclusion-file-list",
                    });
                    for (const file of matchedFiles) {
                        fileListEl.createDiv({ cls: "vault-sync-exclusion-file-item", text: file });
                    }
                }
            } else {
                item.createDiv({
                    cls: "vault-sync-exclusion-match-count vault-sync-exclusion-match-loading",
                    text: "...",
                });
            }

            // Delete button
            const deleteBtn = item.createDiv({ cls: "vault-sync-exclusion-delete" });
            setIcon(deleteBtn, "x");
            const idx = i;
            deleteBtn.addEventListener("click", () => {
                this.expandedPatterns.delete(this.patterns[idx]);
                this.patterns.splice(idx, 1);
                this.savePatterns();
                this.renderList();
            });
        }
    }

    private getActiveToggleExclusions(): ToggleExclusion[] {
        return TOGGLE_EXCLUSIONS.filter((te) => !this.plugin.settings[te.settingKey]);
    }

    private renderToggleExclusions(): void {
        const activeExclusions = this.getActiveToggleExclusions();
        if (activeExclusions.length === 0) return;

        // Section label
        this.listEl.createDiv({
            cls: "vault-sync-exclusion-section-label",
            text: t("settingExclusionModalToggleExclusion"),
        });

        for (const te of activeExclusions) {
            const itemContainer = this.listEl.createDiv({
                cls: "vault-sync-exclusion-item-container vault-sync-exclusion-item-managed",
            });
            const item = itemContainer.createDiv({ cls: "vault-sync-exclusion-item" });

            // Setting label as pattern text
            const label = t(te.label as Parameters<typeof t>[0]);
            item.createSpan({
                cls: "vault-sync-exclusion-item-pattern",
                text: te.patterns.join(", "),
            });

            // Managed badge (instead of delete button)
            item.createDiv({
                cls: "vault-sync-exclusion-managed-badge",
                text: label,
            });
        }
    }

    private updateStatus(): void {
        if (!this.pathsLoaded) {
            this.statusEl.setText(t("settingExclusionModalScanning"));
        } else {
            this.statusEl.setText(
                t("settingExclusionModalFileCount").replace("{0}", String(this.allPaths.length)),
            );
        }
    }

    private onInputChange(): void {
        const query = this.inputComp.getValue().trim();
        this.errorEl.style.display = "none";

        if (!query) {
            this.hideSuggest();
            return;
        }

        this.showSuggest(query);
    }

    private showSuggest(query: string): void {
        this.suggestEl.empty();
        const lowerQuery = query.toLowerCase();

        const suggestions: { path: string; isFolder: boolean }[] = [];

        // Folders first
        for (const folder of this.allFolders) {
            if (folder.toLowerCase().includes(lowerQuery)) {
                suggestions.push({ path: folder, isFolder: true });
            }
            if (suggestions.length >= 20) break;
        }

        // Then files
        if (suggestions.length < 20) {
            for (const file of this.allPaths) {
                if (file.toLowerCase().includes(lowerQuery)) {
                    suggestions.push({ path: file, isFolder: false });
                }
                if (suggestions.length >= 20) break;
            }
        }

        if (suggestions.length === 0) {
            this.suggestEl.style.display = "none";
            return;
        }

        for (const s of suggestions) {
            const item = this.suggestEl.createDiv({ cls: "vault-sync-exclusion-suggest-item" });
            const icon = item.createSpan({ cls: "vault-sync-exclusion-suggest-icon" });
            setIcon(icon, s.isFolder ? "folder" : "file");
            item.createSpan({ text: s.isFolder ? `${s.path}/**` : s.path });
            item.addEventListener("click", () => {
                const pattern = s.isFolder ? `${s.path}/**` : s.path;
                this.inputComp.setValue(pattern);
                this.hideSuggest();
                this.addCurrentPattern();
            });
        }

        this.suggestEl.style.display = "";
    }

    private hideSuggest(): void {
        this.suggestEl.style.display = "none";
    }

    private addCurrentPattern(): void {
        const pattern = this.inputComp.getValue().trim();
        if (!pattern) return;

        // Check duplicate
        if (this.patterns.includes(pattern)) {
            this.errorEl.setText(t("settingExclusionModalDuplicate"));
            this.errorEl.style.display = "";
            return;
        }

        // Validate glob syntax
        if (!this.isValidPattern(pattern)) {
            this.errorEl.setText(t("settingExclusionPatternsInvalid"));
            this.errorEl.style.display = "";
            return;
        }

        this.patterns.push(pattern);
        this.savePatterns();
        this.renderList();
        this.inputComp.setValue("");
        this.hideSuggest();
        this.errorEl.style.display = "none";
    }

    private isValidPattern(pattern: string): boolean {
        const openBracket = (pattern.match(/\[/g) || []).length;
        const closeBracket = (pattern.match(/\]/g) || []).length;
        if (openBracket !== closeBracket) return false;
        const openBrace = (pattern.match(/\{/g) || []).length;
        const closeBrace = (pattern.match(/\}/g) || []).length;
        return openBrace === closeBrace;
    }

    private getMatchedFiles(pattern: string): string[] {
        const lowerPattern = pattern.toLowerCase();
        const matched: string[] = [];
        for (const file of this.allPaths) {
            if (matchWildcard(lowerPattern, file.toLowerCase())) {
                matched.push(file);
            }
        }
        return matched;
    }

    private savePatterns(): void {
        this.plugin.settings.exclusionPatterns = this.patterns.join("\n");
        this.plugin.saveSettings();
    }
}
