import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import type { FirstSyncMode, FirstSyncSummary } from "../sync-manager/first-sync";

/** Paths listed under "differ" before the rest is summarized */
const MAX_LISTED = 20;

const fill = (text: string, n: number) => text.replace("{n}", String(n));

type StartMode = Exclude<FirstSyncMode, "later">;

const MODES: { mode: StartMode; label: string; desc: string }[] = [
    { mode: "merge", label: "firstSyncMerge", desc: "firstSyncMergeDesc" },
    { mode: "cloud", label: "firstSyncCloud", desc: "firstSyncCloudDesc" },
    { mode: "local", label: "firstSyncLocal", desc: "firstSyncLocalDesc" },
];

/**
 * Asks how a device's first sync starts when this device and the cloud both
 * have notes. Resolves "later" when the user holds the sync or closes the screen.
 */
export class FirstSyncModal extends Modal {
    private result: FirstSyncMode = "later";
    private selected: StartMode = "merge";
    private resolve: ((mode: FirstSyncMode) => void) | null = null;

    constructor(
        app: App,
        private readonly summary: FirstSyncSummary,
    ) {
        super(app);
    }

    ask(): Promise<FirstSyncMode> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        const s = this.summary;
        this.setTitle(t("firstSyncTitle"));
        contentEl.createEl("p", { text: t("firstSyncIntro") });

        const counts = contentEl.createEl("ul", { cls: "vault-sync-first-sync-counts" });
        counts.createEl("li", { text: fill(t("firstSyncIdentical"), s.identical.length) });
        counts.createEl("li", { text: fill(t("firstSyncDiffering"), s.differing.length) });
        counts.createEl("li", { text: fill(t("firstSyncLocalOnly"), s.localOnly.length) });
        counts.createEl("li", { text: fill(t("firstSyncCloudOnly"), s.cloudOnly.length) });

        if (s.differing.length > 0) {
            const details = contentEl.createEl("details");
            details.createEl("summary", { text: t("firstSyncDifferingList") });
            const list = details.createEl("ul", { cls: "vault-sync-mass-delete-list" });
            for (const path of s.differing.slice(0, MAX_LISTED)) list.createEl("li", { text: path });
            if (s.differing.length > MAX_LISTED) {
                list.createEl("li", { text: fill(t("massDeleteMore"), s.differing.length - MAX_LISTED) });
            }
        }

        const warning = contentEl.createEl("p", { cls: "mod-warning" });
        const showWarning = () => {
            warning.setText(this.selected === "local" ? fill(t("firstSyncLocalWarning"), s.cloudOnly.length) : "");
            warning.toggle(this.selected === "local");
        };

        const group = contentEl.createDiv({ cls: "vault-sync-first-sync-modes" });
        for (const m of MODES) {
            const row = new Setting(group).setName(t(m.label)).setDesc(t(m.desc));
            const radio = row.controlEl.createEl("input", { type: "radio" });
            radio.name = "vault-sync-first-sync-mode";
            radio.checked = m.mode === this.selected;
            const pick = () => {
                this.selected = m.mode;
                radio.checked = true;
                showWarning();
            };
            radio.addEventListener("change", pick);
            row.settingEl.addEventListener("click", pick);
        }
        contentEl.appendChild(warning);
        showWarning();

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText(t("firstSyncLater")).onClick(() => this.close()))
            .addButton((btn) =>
                btn
                    .setButtonText(t("firstSyncStart"))
                    .setCta()
                    .onClick(() => {
                        this.result = this.selected;
                        this.close();
                    }),
            );
    }

    onClose(): void {
        this.contentEl.empty();
        this.resolve?.(this.result);
        this.resolve = null;
    }
}
