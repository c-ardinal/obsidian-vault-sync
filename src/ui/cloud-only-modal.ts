import { App, FuzzySuggestModal, Notice, TFile, type FuzzyMatch } from "obsidian";
import type { SyncManager } from "../sync-manager";
import { matchLinkedFiles, type CloudOnlyFile } from "../sync-manager/on-demand";
import { formatSize } from "../utils/format";
import { t } from "../i18n";

/** Picker of the cloud files this device leaves out; the chosen one is fetched and opened */
class CloudOnlyPickerModal extends FuzzySuggestModal<CloudOnlyFile> {
    constructor(
        app: App,
        private readonly files: CloudOnlyFile[],
        private readonly fetchOne: (f: CloudOnlyFile) => Promise<void>,
    ) {
        super(app);
        this.setPlaceholder(t("cloudOnlyPick"));
    }

    getItems(): CloudOnlyFile[] {
        return this.files;
    }

    getItemText(item: CloudOnlyFile): string {
        return item.path;
    }

    renderSuggestion(match: FuzzyMatch<CloudOnlyFile>, el: HTMLElement): void {
        super.renderSuggestion(match, el);
        el.createSpan({ cls: "vault-sync-suggest-note", text: ` ${formatSize(match.item.size)}` });
    }

    onChooseItem(item: CloudOnlyFile): void {
        void this.fetchOne(item);
    }
}

async function fetchAndOpen(app: App, sm: SyncManager, file: CloudOnlyFile, open: boolean): Promise<boolean> {
    try {
        await sm.fetchCloudOnlyFile(file);
        if (open) {
            const f = app.vault.getAbstractFileByPath(file.path);
            if (f instanceof TFile) await app.workspace.getLeaf(false).openFile(f);
        }
        return true;
    } catch (e) {
        new Notice(t("cloudOnlyFetchFailed").replace("{0}", file.path));
        void sm.log(`[On demand] Fetch failed for ${file.path}: ${String(e)}`, "error");
        return false;
    }
}

async function loadList(sm: SyncManager): Promise<CloudOnlyFile[] | null> {
    try {
        return await sm.listCloudOnlyFiles();
    } catch (e) {
        new Notice(sm.isSignedIn === false ? t("cloudOnlySignInRequired") : t("cloudOnlyListFailed"));
        void sm.log(`[On demand] Listing failed: ${String(e)}`, "error");
        return null;
    }
}

/** Command: pick one of the cloud files this device leaves out, fetch it and open it */
export async function openCloudOnlyPicker(app: App, sm: SyncManager): Promise<void> {
    const files = await loadList(sm);
    if (!files) return;
    if (files.length === 0) {
        new Notice(t("cloudOnlyNone"));
        return;
    }
    new CloudOnlyPickerModal(app, files, async (f) => {
        if (await fetchAndOpen(app, sm, f, true)) new Notice(t("cloudOnlyFetched").replace("{0}", f.path));
    }).open();
}

/** The links and embeds of a note, as written */
export function linksOf(app: App, note: TFile): string[] {
    const cache = app.metadataCache.getFileCache(note);
    return [...(cache?.embeds ?? []), ...(cache?.links ?? [])].map((l) => l.link);
}

/** File menu of a note: fetch the left-out files it links to or embeds */
export async function fetchLinkedCloudOnly(app: App, sm: SyncManager, note: TFile): Promise<void> {
    const files = await loadList(sm);
    if (!files) return;
    const linked = matchLinkedFiles(files, linksOf(app, note), note.path);
    if (linked.length === 0) {
        new Notice(t("cloudOnlyNoneLinked"));
        return;
    }
    let done = 0;
    for (const f of linked) if (await fetchAndOpen(app, sm, f, false)) done++;
    new Notice(t("cloudOnlyFetchedCount").replace("{0}", String(done)));
}
