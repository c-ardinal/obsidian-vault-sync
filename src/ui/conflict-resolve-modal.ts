import { App, FuzzySuggestModal, Modal, Notice, Platform, TFile, normalizePath } from "obsidian";
import { t } from "../i18n";
import {
    buildConflictChunks,
    composeConflictResult,
    decodeText,
    findConflictCopies,
    parseConflictCopyPath,
    resolveConflictCopy,
    type ChunkChoice,
    type ConflictChunk,
    type ConflictVault,
} from "../sync-manager/conflict-resolution";

/** Lines of a shared run shown around a differing part; the rest is folded */
const CONTEXT_LINES = 2;

const fill = (text: string, n: number) => text.replace("{n}", String(n));

function obsidianConflictVault(app: App): ConflictVault {
    return {
        exists: (path) => app.vault.adapter.exists(path),
        readBinary: async (path) => {
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) throw new Error(`Missing: ${path}`);
            return app.vault.readBinary(file);
        },
        writeNote: async (path, data) => {
            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await app.vault.modifyBinary(file, data);
                return;
            }
            const slash = path.lastIndexOf("/");
            if (slash > 0) {
                const dir = normalizePath(path.slice(0, slash));
                if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
            }
            await app.vault.createBinary(path, data);
        },
        trash: async (path) => {
            const file = app.vault.getAbstractFileByPath(path);
            if (file) await app.fileManager.trashFile(file);
        },
    };
}

/**
 * Compare a conflict copy (this device's version) with the note (the cloud's
 * version) and choose, per differing part, which lines to keep.
 */
export class ConflictResolveModal extends Modal {
    private chunks: ConflictChunk[] = [];
    private choices: ChunkChoice[] = [];
    private resultEl: HTMLTextAreaElement | null = null;
    private localData: ArrayBuffer | null = null;
    private readonly vault: ConflictVault;

    constructor(
        app: App,
        private readonly copyPath: string,
    ) {
        super(app);
        this.vault = obsidianConflictVault(app);
        this.modalEl.addClass("vault-sync-conflict-modal");
    }

    onOpen(): void {
        void this.load();
    }

    private async load(): Promise<void> {
        const { contentEl } = this;
        const parsed = parseConflictCopyPath(this.copyPath);
        if (!parsed) {
            this.close();
            return;
        }
        this.setTitle(t("conflictResolveTitle"));
        contentEl.createEl("p", { cls: "vault-sync-conflict-path", text: parsed.originalPath });

        let local: string | null;
        let remote: string | null = "";
        let remoteMissing = false;
        try {
            this.localData = await this.vault.readBinary(this.copyPath);
            local = decodeText(this.localData);
            if (await this.vault.exists(parsed.originalPath)) {
                remote = decodeText(await this.vault.readBinary(parsed.originalPath));
            } else {
                remoteMissing = true;
            }
        } catch (e) {
            contentEl.createEl("p", { cls: "mod-warning", text: String(e) });
            return;
        }

        if (local === null || remote === null) {
            contentEl.createEl("p", { text: t("conflictResolveBinary") });
            this.renderButtons(false);
            return;
        }

        this.chunks = buildConflictChunks(local, remote);
        const differing = this.chunks.filter((c) => c.kind === "differ").length;
        this.choices = new Array<ChunkChoice>(differing).fill("remote");

        contentEl.createEl("p", {
            text: differing === 0 ? t("conflictResolveSame") : fill(t("conflictResolveIntro"), differing),
        });
        if (remoteMissing) contentEl.createEl("p", { cls: "mod-warning", text: t("conflictResolveRemoteMissing") });

        if (differing > 0) this.renderChunks(contentEl);

        contentEl.createEl("h4", { text: t("conflictResolveResult") });
        contentEl.createDiv({ cls: "vault-sync-conflict-hint", text: t("conflictResolveResultDesc") });
        this.resultEl = contentEl.createDiv().createEl("textarea", { cls: "vault-sync-conflict-result" });
        this.resultEl.rows = Platform.isPhone ? 8 : 12;
        this.resultEl.spellcheck = false;
        this.refreshResult();

        this.renderButtons(true);
    }

    private renderChunks(parent: HTMLElement): void {
        const list = parent.createDiv({ cls: "vault-sync-conflict-chunks" });
        let d = 0;
        this.chunks.forEach((chunk, i) => {
            if (chunk.kind === "same") {
                this.renderSame(list, chunk.lines, i === 0, i === this.chunks.length - 1);
                return;
            }
            const index = d++;
            const box = list.createDiv({ cls: "vault-sync-conflict-chunk" });
            const panes = box.createDiv({ cls: "vault-sync-conflict-panes" });
            const pane = (label: string, lines: string[]) => {
                const el = panes.createDiv({ cls: "vault-sync-conflict-pane" });
                el.createDiv({ cls: "vault-sync-conflict-pane-label", text: label });
                el.createEl("pre", { text: lines.length > 0 ? lines.join("") : t("conflictResolveNoLines") });
            };
            pane(t("conflictResolveLocal"), chunk.local);
            pane(t("conflictResolveRemote"), chunk.remote);

            const options: { choice: ChunkChoice; label: string }[] = [
                { choice: "local", label: "conflictResolveUseLocal" },
                { choice: "remote", label: "conflictResolveUseRemote" },
                { choice: "both", label: "conflictResolveUseBoth" },
            ];
            const row = box.createDiv({ cls: "vault-sync-conflict-choices" });
            const buttons: HTMLButtonElement[] = [];
            for (const o of options) {
                const btn = row.createEl("button", { text: t(o.label) });
                buttons.push(btn);
                btn.addEventListener("click", () => {
                    this.choices[index] = o.choice;
                    buttons.forEach((b, j) => b.toggleClass("mod-cta", options[j].choice === o.choice));
                    this.refreshResult();
                });
                btn.toggleClass("mod-cta", this.choices[index] === o.choice);
            }
        });
    }

    /** A shared run: the lines next to differing parts, the rest folded */
    private renderSame(parent: HTMLElement, lines: string[], first: boolean, last: boolean): void {
        const head = first ? 0 : CONTEXT_LINES;
        const tail = last ? 0 : CONTEXT_LINES;
        const el = parent.createDiv({ cls: "vault-sync-conflict-same" });
        if (lines.length <= head + tail + 1) {
            el.createEl("pre", { text: lines.join("") });
            return;
        }
        if (head > 0) el.createEl("pre", { text: lines.slice(0, head).join("") });
        el.createDiv({
            cls: "vault-sync-conflict-fold",
            text: fill(t("conflictResolveSameLines"), lines.length - head - tail),
        });
        if (tail > 0) el.createEl("pre", { text: lines.slice(lines.length - tail).join("") });
    }

    private refreshResult(): void {
        if (this.resultEl) this.resultEl.value = composeConflictResult(this.chunks, this.choices);
    }

    private renderButtons(text: boolean): void {
        const row = this.contentEl.createDiv({ cls: "modal-button-container vault-sync-conflict-buttons" });
        const button = (label: string, onClick: () => void, cta = false) => {
            const btn = row.createEl("button", { text: t(label) });
            if (cta) btn.addClass("mod-cta");
            btn.addEventListener("click", onClick);
        };
        button("conflictResolveKeepLocal", () => void this.finish(this.localData));
        button("conflictResolveKeepRemote", () => void this.finish(null));
        if (text) {
            button(
                "conflictResolveSave",
                () => {
                    const value = this.resultEl?.value ?? "";
                    void this.finish(new TextEncoder().encode(value).buffer);
                },
                true,
            );
        }
    }

    private async finish(result: ArrayBuffer | null): Promise<void> {
        try {
            const path = await resolveConflictCopy(this.vault, this.copyPath, result);
            new Notice(t("conflictResolveDone").replace("{path}", path));
            this.close();
        } catch (e) {
            new Notice(`${t("conflictResolveFailed")}: ${String(e)}`);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class ConflictPickerModal extends FuzzySuggestModal<{ path: string; originalPath: string; stamp: string }> {
    constructor(
        app: App,
        private readonly copies: { path: string; originalPath: string; stamp: string }[],
    ) {
        super(app);
        this.setPlaceholder(t("conflictResolvePick"));
    }

    getItems() {
        return this.copies;
    }

    getItemText(item: { path: string; originalPath: string; stamp: string }): string {
        return item.path;
    }

    onChooseItem(item: { path: string; originalPath: string; stamp: string }): void {
        new ConflictResolveModal(this.app, item.path).open();
    }
}

/** Open the resolve screen: directly for one conflict copy, through a picker for several */
export function openConflictResolver(app: App): void {
    const copies = findConflictCopies(app.vault.getFiles().map((f) => f.path));
    if (copies.length === 0) {
        new Notice(t("conflictResolveNone"));
        return;
    }
    if (copies.length === 1) {
        new ConflictResolveModal(app, copies[0].path).open();
        return;
    }
    new ConflictPickerModal(app, copies).open();
}
