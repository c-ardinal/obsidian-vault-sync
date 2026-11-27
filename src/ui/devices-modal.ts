import { App, DropdownComponent, Modal, Notice, Setting, TFile } from "obsidian";
import { formatDateTime } from "./format-time";
import { t } from "../i18n";
import { mergeActivity, type ActivityOp, type DeviceActivity, type DeviceRecord } from "../sync-manager/device-registry";

/** What the screen needs from the sync */
export interface DevicesSource {
    readonly thisDeviceId: string;
    listDevices(): Promise<DeviceRecord[]>;
    forgetDevice(deviceId: string): Promise<void>;
    getDeviceName(): Promise<string>;
    setDeviceName(name: string): Promise<void>;
}

/** Changes shown at first, and added per "show more" */
const PAGE = 100;

const OP_LABELS: Record<ActivityOp, string> = {
    create: "devicesOpCreate",
    edit: "devicesOpEdit",
    delete: "devicesOpDelete",
    rename: "devicesOpRename",
    conflict: "devicesOpConflict",
};

const fill = (text: string, key: string, value: string | number) => text.replace(`{${key}}`, String(value));

const formatTime = formatDateTime;

/** The devices that sync this vault, and the changes each of them made */
export class DevicesModal extends Modal {
    private records: DeviceRecord[] = [];
    private filter = "";
    private shown = PAGE;

    constructor(
        app: App,
        private readonly source: DevicesSource,
    ) {
        super(app);
        this.modalEl.addClass("vault-syncer-devices-modal");
    }

    onOpen(): void {
        this.setTitle(t("devicesTitle"));
        void this.load();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async load(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("p", { cls: "vault-syncer-devices-note", text: t("devicesIntro") });
        const status = contentEl.createEl("p", { text: t("remoteTrashLoading") });
        try {
            this.records = await this.source.listDevices();
        } catch {
            status.setText(t("devicesFailed"));
            return;
        }
        status.remove();
        this.renderDevices();
        this.renderActivity();
    }

    private renderDevices(): void {
        const { contentEl } = this;
        new Setting(contentEl).setName(t("devicesListHeading")).setHeading().settingEl.addClass("vault-syncer-modal-heading");
        const own = this.records.some((r) => r.id === this.source.thisDeviceId);
        if (!own) {
            contentEl.createEl("p", { cls: "vault-syncer-devices-note", text: t("devicesThisNotYet") });
        }
        for (const r of this.records) {
            const isThis = r.id === this.source.thisDeviceId;
            const row = new Setting(contentEl)
                .setName(isThis ? fill(t("devicesThisDevice"), "name", r.name) : r.name)
                .setDesc(
                    [r.platform, fill(t("devicesLastSync"), "time", formatTime(r.lastSyncAt))]
                        .filter((s) => s)
                        .join(" · "),
                );
            if (isThis) {
                let value = r.name;
                row.addText((text) => {
                    text.setValue(r.name).onChange((v) => (value = v));
                    text.inputEl.setAttr("aria-label", t("devicesName"));
                });
                row.addButton((btn) =>
                    btn.setButtonText(t("devicesRename")).onClick(async () => {
                        await this.source.setDeviceName(value);
                        new Notice(t("devicesRenamed"));
                    }),
                );
            } else {
                row.addButton((btn) =>
                    btn
                        .setButtonText(t("devicesForget"))
                        .onClick(async () => {
                            btn.setDisabled(true);
                            try {
                                await this.source.forgetDevice(r.id);
                                this.records = this.records.filter((x) => x.id !== r.id);
                                this.redraw();
                            } catch {
                                btn.setDisabled(false);
                                new Notice(t("devicesFailed"));
                            }
                        }),
                );
            }
        }
        if (this.records.length > 1) {
            contentEl.createEl("p", { cls: "vault-syncer-devices-note", text: t("devicesForgetDesc") });
        }
    }

    private redraw(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("p", { cls: "vault-syncer-devices-note", text: t("devicesIntro") });
        this.renderDevices();
        this.renderActivity();
    }

    private renderActivity(): void {
        const { contentEl } = this;
        const heading = new Setting(contentEl).setName(t("devicesActivityHeading")).setHeading();
        heading.settingEl.addClass("vault-syncer-modal-heading");
        const dd = new DropdownComponent(heading.controlEl);
        dd.addOption("", t("devicesAllDevices"));
        for (const r of this.records) dd.addOption(r.id, r.name);
        dd.setValue(this.filter).onChange((v) => {
            this.filter = v;
            this.shown = PAGE;
            renderList();
        });

        const listEl = contentEl.createDiv({ cls: "vault-syncer-activity-list" });
        const all = mergeActivity(this.records);
        const renderList = () => {
            listEl.empty();
            const items = this.filter ? all.filter((a) => a.deviceId === this.filter) : all;
            if (items.length === 0) {
                listEl.createEl("p", { cls: "vault-syncer-devices-note", text: t("devicesNoActivity") });
                return;
            }
            for (const a of items.slice(0, this.shown)) this.renderEntry(listEl, a);
            if (items.length > this.shown) {
                const more = listEl.createEl("button", {
                    cls: "vault-syncer-activity-more",
                    text: fill(t("devicesShowMore"), "n", items.length - this.shown),
                });
                more.addEventListener("click", () => {
                    this.shown += PAGE;
                    renderList();
                });
            }
        };
        renderList();
    }

    private renderEntry(parent: HTMLElement, a: DeviceActivity): void {
        const row = parent.createDiv({ cls: "vault-syncer-activity-row" });
        const meta = row.createDiv({ cls: "vault-syncer-activity-meta" });
        meta.createSpan({ text: formatTime(a.t) });
        meta.createSpan({ text: a.deviceName });
        meta.createSpan({ cls: `vault-syncer-activity-op mod-${a.op}`, text: t(OP_LABELS[a.op] ?? "devicesOpEdit") });
        const pathEl = row.createDiv({ cls: "vault-syncer-activity-path" });
        const file = this.app.vault.getAbstractFileByPath(a.path);
        if (a.op === "rename" && a.from) pathEl.createSpan({ cls: "vault-syncer-activity-from", text: `${a.from} → ` });
        if (file instanceof TFile) {
            const link = pathEl.createEl("a", { text: a.path, href: "#" });
            link.addEventListener("click", (e) => {
                e.preventDefault();
                void this.app.workspace.openLinkText(a.path, "", true);
                this.close();
            });
        } else {
            pathEl.createSpan({ text: a.path });
        }
    }
}
