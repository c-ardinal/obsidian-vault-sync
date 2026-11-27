/**
 * Settings shape versioning: defaults merging and step-by-step migrations.
 *
 * Saved settings come from older plugin versions and from other devices (the
 * open part is synced), so loading must (1) fill in every field a newer version
 * added, at any depth, and (2) convert old shapes to the current one exactly once.
 */

/** Version of the settings shape this build writes. Raise it with each migration. */
export const CURRENT_SETTINGS_VERSION = 1;

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
    return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function clone<T>(v: T): T {
    if (Array.isArray(v)) return v.map(clone) as T;
    if (isPlainObject(v)) {
        const out: PlainObject = {};
        for (const [k, val] of Object.entries(v)) out[k] = clone(val);
        return out as T;
    }
    return v;
}

/**
 * Saved values over defaults, merged into nested objects too: a field added to a
 * nested group (e.g. a trigger setting) gets its default instead of staying
 * undefined. The result shares no objects with either input, so changing the
 * settings never changes the defaults. Unknown saved keys are kept (a newer
 * version on another device may have written them).
 */
export function mergeWithDefaults<T extends object>(defaults: T, saved: Partial<T>): T {
    const out = clone(defaults) as PlainObject;
    for (const [key, value] of Object.entries(saved as PlainObject)) {
        if (value === undefined) continue;
        const base = out[key];
        out[key] = isPlainObject(base) && isPlainObject(value) ? mergeWithDefaults(base, value) : clone(value);
    }
    return out as T;
}

/** One step: converts settings of version `from` to `from + 1`, in place. */
export interface SettingsMigration {
    from: number;
    migrate(settings: PlainObject): void;
}

/**
 * Migrations in order. Settings saved before versioning have no version and are
 * version 0; 0 -> 1 only records the version (no shape change).
 */
export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [{ from: 0, migrate: () => {} }];

/**
 * Bring saved settings to CURRENT_SETTINGS_VERSION. Settings written by a newer
 * version (another device updated first) are left as they are: an older build
 * cannot know how to convert them back. Returns whether anything changed.
 */
export function migrateSettings(
    settings: PlainObject,
    migrations: readonly SettingsMigration[] = SETTINGS_MIGRATIONS,
    target: number = CURRENT_SETTINGS_VERSION,
): boolean {
    const stored = typeof settings.settingsVersion === "number" ? settings.settingsVersion : 0;
    if (stored >= target) return false;
    let version = stored;
    while (version < target) {
        const step = migrations.find((m) => m.from === version);
        if (!step) throw new Error(`No settings migration from version ${version}`);
        step.migrate(settings);
        version++;
    }
    settings.settingsVersion = version;
    return true;
}
