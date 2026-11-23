/**
 * @file 大容量転送の延期条件の試験
 *
 * @pass_criteria
 * - モバイル回線・データ節約時に延期、Wi-Fi 時は延期しないこと
 * - 電池 20% 未満かつ非充電時のみ延期すること
 * - 設定無効時・情報取得不可（iOS）時は延期しないこと
 */
import { describe, it, expect } from "vitest";
import { deferReason } from "../../../src/sync-manager/transfer-conditions";

const on = { deferLargeOnCellular: true, deferLargeOnLowBattery: true };
const battery = (level: number, charging: boolean) => async () => ({ level, charging });

describe("large transfer conditions", () => {
    it("waits on a mobile network or data saver", async () => {
        expect(await deferReason(on, { connection: { type: "cellular" } })).toBe("cellular");
        expect(await deferReason(on, { connection: { type: "wifi", saveData: true } })).toBe("cellular");
        expect(await deferReason(on, { connection: { type: "wifi" } })).toBeNull();
    });

    it("waits on a low battery that is not charging", async () => {
        expect(await deferReason(on, { getBattery: battery(0.1, false) })).toBe("low-battery");
        expect(await deferReason(on, { getBattery: battery(0.1, true) })).toBeNull();
        expect(await deferReason(on, { getBattery: battery(0.5, false) })).toBeNull();
    });

    it("goes ahead when off, or when the device tells nothing (iOS)", async () => {
        expect(await deferReason({}, { connection: { type: "cellular" }, getBattery: battery(0.01, false) })).toBeNull();
        expect(await deferReason(on, {})).toBeNull();
        expect(
            await deferReason(on, {
                getBattery: async () => {
                    throw new Error("no");
                },
            }),
        ).toBeNull();
    });
});
