import { describe, it, expect } from "vitest";
import {
    CURRENT_SETTINGS_VERSION,
    mergeWithDefaults,
    migrateSettings,
    type SettingsMigration,
} from "../../../src/services/settings-migration";
import { DEFAULT_SETTINGS } from "../../../src/constants";

describe("mergeWithDefaults", () => {
    it("fills fields missing from a saved nested group", () => {
        const merged = mergeWithDefaults(DEFAULT_SETTINGS, {
            unifiedTriggers: { autoSyncIntervalSec: 60 } as never,
        });
        expect(merged.unifiedTriggers.autoSyncIntervalSec).toBe(60);
        expect(merged.unifiedTriggers.onModifyDelaySec).toBe(
            DEFAULT_SETTINGS.unifiedTriggers.onModifyDelaySec,
        );
    });

    it("shares no objects with the defaults", () => {
        const merged = mergeWithDefaults(DEFAULT_SETTINGS, {});
        merged.mobileTriggers.autoSyncIntervalSec = 999;
        expect(DEFAULT_SETTINGS.mobileTriggers.autoSyncIntervalSec).not.toBe(999);
    });

    it("takes saved values, keeps unknown keys, ignores undefined", () => {
        const merged = mergeWithDefaults(DEFAULT_SETTINGS, {
            concurrency: 2,
            notificationLevel: undefined,
            futureKey: "x",
        } as never) as unknown as Record<string, unknown>;
        expect(merged.concurrency).toBe(2);
        expect(merged.notificationLevel).toBe(DEFAULT_SETTINGS.notificationLevel);
        expect(merged.futureKey).toBe("x");
    });

    it("gives the same result as before for complete saved settings", () => {
        const saved = { ...DEFAULT_SETTINGS, concurrency: 3, cloudRootFolder: "X" };
        expect(mergeWithDefaults(DEFAULT_SETTINGS, saved)).toEqual(
            Object.assign({}, DEFAULT_SETTINGS, saved),
        );
    });

    it("replaces records and arrays saved as values", () => {
        const merged = mergeWithDefaults({ list: [1, 2], rec: {} as Record<string, number> }, {
            list: [3],
            rec: { a: 1 },
        });
        expect(merged).toEqual({ list: [3], rec: { a: 1 } });
    });
});

describe("migrateSettings", () => {
    it("stamps unversioned settings with the current version", () => {
        const s: Record<string, unknown> = {};
        expect(migrateSettings(s)).toBe(true);
        expect(s.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    });

    it("does nothing for current settings", () => {
        const s: Record<string, unknown> = { settingsVersion: CURRENT_SETTINGS_VERSION };
        expect(migrateSettings(s)).toBe(false);
    });

    it("leaves settings written by a newer version untouched", () => {
        const s: Record<string, unknown> = { settingsVersion: CURRENT_SETTINGS_VERSION + 5, a: 1 };
        expect(migrateSettings(s)).toBe(false);
        expect(s).toEqual({ settingsVersion: CURRENT_SETTINGS_VERSION + 5, a: 1 });
    });

    it("runs each step once, in order", () => {
        const order: number[] = [];
        const steps: SettingsMigration[] = [
            { from: 1, migrate: (s) => { order.push(1); s.b = (s.a as number) * 2; } },
            { from: 0, migrate: (s) => { order.push(0); s.a = 1; } },
        ];
        const s: Record<string, unknown> = {};
        migrateSettings(s, steps, 2);
        expect(order).toEqual([0, 1]);
        expect(s).toEqual({ a: 1, b: 2, settingsVersion: 2 });
    });

    it("fails loudly when a step is missing", () => {
        expect(() => migrateSettings({ settingsVersion: 0 }, [], 1)).toThrow(/No settings migration/);
    });

    it("moves the record of an installed add-on to the add-on's current ID", () => {
        const record = { name: "Vault Syncer E2EE Engine", version: "0.19.0", termsHash: "h", agreedAt: "t" };
        const s: Record<string, unknown> = {
            settingsVersion: 1,
            addonAgreements: { "vault-sync-e2ee-engine": record },
        };
        expect(migrateSettings(s)).toBe(true);
        expect(s.addonAgreements).toEqual({ "vault-syncer-e2ee-engine": record });
    });

    it("keeps a record already saved under the current add-on ID", () => {
        const s: Record<string, unknown> = {
            settingsVersion: 1,
            addonAgreements: {
                "vault-sync-e2ee-engine": { version: "0.19.0" },
                "vault-syncer-e2ee-engine": { version: "0.19.2" },
            },
        };
        migrateSettings(s);
        expect(s.addonAgreements).toEqual({ "vault-syncer-e2ee-engine": { version: "0.19.2" } });
    });
});
