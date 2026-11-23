/**
 * Whether large background transfers should wait: on a mobile network (data
 * plans), or on a low battery that is not charging. Notes keep syncing as
 * usual; only the queue of large files waits, and every sync looks again.
 *
 * The device reports these on Android and on PCs (Chromium's Network
 * Information and Battery Status APIs). iOS reports neither: nothing waits there.
 */

export type DeferReason = "cellular" | "low-battery";

/** Battery level under which transfers wait (when not charging) */
export const LOW_BATTERY_LEVEL = 0.2;

interface ConnectionInfo {
    type?: string;
    saveData?: boolean;
}

interface BatteryInfo {
    level: number;
    charging: boolean;
}

export interface DeviceConditions {
    connection?: ConnectionInfo;
    getBattery?: () => Promise<BatteryInfo>;
}

export interface DeferSettings {
    deferLargeOnCellular?: boolean;
    deferLargeOnLowBattery?: boolean;
}

function deviceConditions(): DeviceConditions {
    if (typeof navigator === "undefined") return {};
    const nav = navigator as Navigator & DeviceConditions;
    return {
        connection: nav.connection,
        getBattery: typeof nav.getBattery === "function" ? () => nav.getBattery!() : undefined,
    };
}

/** Why large transfers should wait now, or null to go ahead */
export async function deferReason(
    settings: DeferSettings,
    conditions: DeviceConditions = deviceConditions(),
): Promise<DeferReason | null> {
    if (settings.deferLargeOnCellular) {
        const c = conditions.connection;
        if (c && (c.type === "cellular" || c.saveData === true)) return "cellular";
    }
    if (settings.deferLargeOnLowBattery && conditions.getBattery) {
        try {
            const b = await conditions.getBattery();
            if (!b.charging && b.level < LOW_BATTERY_LEVEL) return "low-battery";
        } catch {
            /* unknown: go ahead */
        }
    }
    return null;
}
