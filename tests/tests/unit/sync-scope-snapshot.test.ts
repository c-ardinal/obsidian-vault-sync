import { describe, it, expect } from "vitest";
import { takeScopeChange } from "../../../src/sync-manager/sync-scope";

describe("applied sync scope", () => {
    it("sees a per-platform category toggled in place by the settings screen", () => {
        const ctx = {};
        const settings = {
            obsidianScopeStrategy: "per-platform",
            desktopObsidianScope: { syncAppearance: false, syncCommunityPlugins: true },
            mobileObsidianScope: { syncAppearance: true, syncCommunityPlugins: true },
        };
        expect(takeScopeChange(ctx, settings)).toBeNull(); // first record

        settings.desktopObsidianScope.syncAppearance = true; // edited in place

        const change = takeScopeChange(ctx, settings);
        expect(change).not.toBeNull();
        expect((change!.previous.desktopObsidianScope as Record<string, boolean>).syncAppearance).toBe(false);
        expect((change!.current.desktopObsidianScope as Record<string, boolean>).syncAppearance).toBe(true);
        expect(takeScopeChange(ctx, settings)).toBeNull();
    });
});
