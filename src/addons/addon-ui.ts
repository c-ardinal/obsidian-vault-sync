/**
 * What an add-on adds to Vault Syncer's own screens: settings pages of its own,
 * and actions that run from those pages and from the command palette.
 *
 * All display text comes from the add-on. Vault Syncer only draws the parts with
 * Obsidian's standard components and routes clicks and commands back to the
 * add-on, so its own UI stays add-on neutral.
 *
 *   Settings › Add-ons
 *     ├ install / remove row          (Vault Syncer)
 *     └ one row per add-on page  ───► add-on page (sections from getSections())
 *                                       ├ ordinary settings (toggle, text, ...)
 *                                       ├ "action" rows  ─► AddonAction.run()
 *                                       └ "page" rows    ─► another add-on page
 *   Command palette: every action with command !== false
 */

/** One setting row on an add-on page. */
export interface AddonSettingItem {
    /** Plugin setting key for value types (toggle, text, ...); any unique id otherwise. */
    key: string;
    type:
        | "toggle"
        | "text"
        | "number"
        | "dropdown"
        | "textarea"
        | "info"
        | "subheader"
        /** A row with a button that runs `actionId`. Hidden while the action is unavailable. */
        | "action"
        /** A row that opens another page of the same add-on (`pageId`). */
        | "page";
    label: string;
    desc?: string;
    getDesc?: (settings: unknown, plugin: unknown) => string;
    placeholder?: string;
    options?: Record<string, string>;
    unit?: string;
    limits?: { min: number; max: number; default: number; disabled?: number };
    onChange?: (value: unknown, plugin: unknown) => Promise<void>;
    isHidden?: (settings: unknown) => boolean;
    /** type "action": the action to run. Label and description default to the action's. */
    actionId?: string;
    /** type "page": the page to open. */
    pageId?: string;
}

export interface AddonSettingSection {
    id: string;
    title: string;
    description?: string;
    items: AddonSettingItem[];
    isHidden?: (settings: unknown) => boolean;
}

/** Something the add-on does on request (open a dialog, run a task, ...). */
export interface AddonAction {
    /**
     * Stable id: lowercase letters, digits and "-". Also the command id, so
     * keep it unchanged across releases (users bind hotkeys to it).
     */
    id: string;
    /** Name in the command palette, and row name on settings pages. */
    label: string;
    /** Row description on settings pages. */
    description?: string;
    /** Button text on settings pages (default: the label). */
    buttonText?: string;
    /** Button look: "cta" for the main action of a page, "warning" for risky ones. */
    style?: "default" | "cta" | "warning";
    /** false keeps it off the command palette (settings pages only). Default true. */
    command?: boolean;
    /** False hides the command and the row. Default: always available. */
    isAvailable?(): boolean;
    run(): void | Promise<void>;
}

/** A settings page of an add-on, listed on Vault Syncer's add-on page. */
export interface AddonPage {
    /** Unique within the add-on: lowercase letters, digits and "-". */
    id: string;
    title: string;
    /** Shown under the title in the list. */
    description?: string;
    /** Lucide icon name for the list row. */
    icon?: string;
    /** Read every time the page is drawn, so it can reflect the current state. */
    getSections(): AddonSettingSection[];
}

export interface AddonUiContributions {
    /** Pages listed on the add-on page, in this order. */
    pages?: AddonPage[];
    actions?: AddonAction[];
}

/** What Vault Syncer offers back to an add-on's UI code. */
export interface AddonUiHost {
    /** Redraw the settings screen (after the add-on changed its state). */
    refresh(): void;
    /** Open one of this add-on's pages in the settings screen. */
    openPage(pageId: string): void;
    /** Run an action by id. False if it is unknown or unavailable. */
    runAction(actionId: string): Promise<boolean>;
}

export interface RegisteredAddon {
    id: string;
    name: string;
    pages: AddonPage[];
    actions: AddonAction[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isValidAction(a: unknown): a is AddonAction {
    const x = a as AddonAction | null;
    return (
        !!x &&
        typeof x.id === "string" &&
        ID_PATTERN.test(x.id) &&
        typeof x.label === "string" &&
        x.label.trim() !== "" &&
        typeof x.run === "function"
    );
}

function isValidPage(p: unknown): p is AddonPage {
    const x = p as AddonPage | null;
    return (
        !!x &&
        typeof x.id === "string" &&
        ID_PATTERN.test(x.id) &&
        typeof x.title === "string" &&
        x.title.trim() !== "" &&
        typeof x.getSections === "function"
    );
}

/**
 * The UI parts of the add-ons that are active on this device.
 *
 * Add-on code is guarded here: a part with a bad shape is left out, and an
 * add-on callback that throws makes its page empty or its action unavailable
 * instead of breaking the settings screen.
 */
export class AddonUiRegistry {
    private addons = new Map<string, RegisteredAddon>();

    /** @param reservedActionIds ids an action may not take (Vault Syncer's own commands) */
    constructor(private readonly reservedActionIds: ReadonlySet<string> = new Set()) {}

    /** Register (or replace) an add-on's parts. Returns the problems found, for the log. */
    set(addonId: string, name: string, ui: AddonUiContributions | null | undefined): string[] {
        this.addons.delete(addonId);
        const problems: string[] = [];
        const taken = new Set(this.reservedActionIds);
        for (const other of this.addons.values()) for (const a of other.actions) taken.add(a.id);

        const actions: AddonAction[] = [];
        for (const a of Array.isArray(ui?.actions) ? ui.actions : []) {
            if (!isValidAction(a)) {
                problems.push(`action with a bad shape left out (${String((a as AddonAction)?.id)})`);
            } else if (taken.has(a.id)) {
                problems.push(`action id "${a.id}" is already taken, left out`);
            } else {
                taken.add(a.id);
                actions.push(a);
            }
        }

        const pages: AddonPage[] = [];
        const pageIds = new Set<string>();
        for (const p of Array.isArray(ui?.pages) ? ui.pages : []) {
            if (!isValidPage(p)) {
                problems.push(`page with a bad shape left out (${String((p as AddonPage)?.id)})`);
            } else if (pageIds.has(p.id)) {
                problems.push(`page id "${p.id}" appears twice, left out`);
            } else {
                pageIds.add(p.id);
                pages.push(p);
            }
        }

        this.addons.set(addonId, { id: addonId, name, pages, actions });
        return problems;
    }

    remove(addonId: string): void {
        this.addons.delete(addonId);
    }

    list(): RegisteredAddon[] {
        return [...this.addons.values()];
    }

    get(addonId: string): RegisteredAddon | undefined {
        return this.addons.get(addonId);
    }

    findPage(addonId: string, pageId: string): AddonPage | undefined {
        return this.addons.get(addonId)?.pages.find((p) => p.id === pageId);
    }

    findAction(actionId: string): { addon: RegisteredAddon; action: AddonAction } | undefined {
        for (const addon of this.addons.values()) {
            const action = addon.actions.find((a) => a.id === actionId);
            if (action) return { addon, action };
        }
        return undefined;
    }

    /** Actions of all add-ons that may appear in the command palette. */
    commandActions(): AddonAction[] {
        return this.list().flatMap((a) => a.actions.filter((x) => x.command !== false));
    }

    isAvailable(action: AddonAction): boolean {
        try {
            return action.isAvailable ? action.isAvailable() !== false : true;
        } catch (e) {
            console.error(`Vault Syncer: add-on action "${action.id}" availability check failed`, e);
            return false;
        }
    }

    /** Run an action if it exists and is available. Errors are logged, not thrown. */
    async run(actionId: string): Promise<boolean> {
        const found = this.findAction(actionId);
        if (!found || !this.isAvailable(found.action)) return false;
        try {
            await found.action.run();
            return true;
        } catch (e) {
            console.error(`Vault Syncer: add-on action "${actionId}" failed`, e);
            return false;
        }
    }

    /** A page's sections; an add-on error gives an empty page. */
    sectionsOf(page: AddonPage): AddonSettingSection[] {
        try {
            const sections = page.getSections();
            return Array.isArray(sections) ? sections.filter((s) => s && Array.isArray(s.items)) : [];
        } catch (e) {
            console.error(`Vault Syncer: add-on page "${page.id}" failed to build`, e);
            return [];
        }
    }
}
