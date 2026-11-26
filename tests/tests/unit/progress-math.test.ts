/**
 * @file 同期状態の検証：進捗表示の算出
 *
 * @description
 * 検証ダイアログのゲージと残り時間の算出 (verifyEstimate)、および同期状況パネルの
 * 段階別ゲージの算出 (stepFraction) を検証する。
 *
 * @pass_criteria
 * - クラウド一覧の取得中は進捗率・残り時間とも不明
 * - 照合中はバイト数基準で進捗率を算出し、経過時間から残り時間を算出
 * - 開始直後は残り時間を表示しない
 * - 段階別ゲージは当該段階の進捗率で増加し、尺度の無い段階は不確定
 * - 1 行表示のファイル名は、転送開始が最新のファイルを方向の矢印付きで表示し、
 *   転送完了後も同一サイクル中は保持、次サイクルの開始で消去
 */
import { describe, it, expect } from "vitest";
import { stepFraction, transferLabel, TRANSFER_NAME_MAX, verifyEstimate } from "../../../src/ui/progress-math";
import { SyncProgressTracker } from "../../../src/sync-manager/sync-progress";

describe("verifyEstimate", () => {
    it("knows nothing while the cloud is listed", () => {
        expect(verifyEstimate({ stage: "listing" }, 9000)).toEqual({ fraction: null, etaSec: null });
    });

    it("measures by bytes and estimates the time left from the time spent", () => {
        const p = { stage: "comparing" as const, done: 1, total: 10, bytesDone: 250, bytesTotal: 1000 };
        expect(verifyEstimate(p, 10_000)).toEqual({ fraction: 0.25, etaSec: 30 });
    });

    it("counts files when no size is known", () => {
        const p = { stage: "comparing" as const, done: 5, total: 10, bytesDone: 0, bytesTotal: 0 };
        expect(verifyEstimate(p, 4000)).toEqual({ fraction: 0.5, etaSec: 4 });
    });

    it("gives no time left right after the start, nor at the end", () => {
        const early = { stage: "comparing" as const, done: 1, total: 10, bytesDone: 100, bytesTotal: 1000 };
        expect(verifyEstimate(early, 500).etaSec).toBeNull();
        const end = { stage: "comparing" as const, done: 10, total: 10, bytesDone: 1000, bytesTotal: 1000 };
        expect(verifyEstimate(end, 9000)).toEqual({ fraction: 1, etaSec: null });
        expect(verifyEstimate({ stage: "comparing", done: 0, total: 0, bytesDone: 0, bytesTotal: 0 }, 9000).fraction).toBe(1);
    });
});

describe("stepFraction", () => {
    it("fills each step with its own progress", () => {
        const tr = new SyncProgressTracker(() => 0);
        tr.begin("manual-sync");
        // Checking the cloud has no measure.
        expect(stepFraction(tr.snapshot(), "checking", false, true)).toBeNull();
        expect(stepFraction(tr.snapshot(), "pulling", false, false)).toBe(0);

        tr.plan("pull", [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }, { path: "d.md" }]);
        tr.plan("push", [{ path: "x.md", size: 100 }, { path: "y.md", size: 300 }]);
        tr.fileFinished("pull", "a.md");
        expect(stepFraction(tr.snapshot(), "checking", true, false)).toBe(1);
        expect(stepFraction(tr.snapshot(), "pulling", true, false)).toBe(0.25);
        expect(stepFraction(tr.snapshot(), "pushing", false, true)).toBe(0);
        tr.fileFinished("push", "x.md");
        // one of two files, 100 of 400 bytes
        expect(stepFraction(tr.snapshot(), "pushing", false, true)).toBe(0.375);

        tr.setPhase("finishing");
        expect(stepFraction(tr.snapshot(), "finishing", false, true)).toBeNull();
    });

    it("follows the scan count during a full scan", () => {
        const tr = new SyncProgressTracker(() => 0);
        tr.begin("full-scan", "scanning");
        expect(stepFraction(tr.snapshot(), "scanning", false, true)).toBeNull();
        tr.scanProgress(120, 480);
        expect(stepFraction(tr.snapshot(), "scanning", false, true)).toBe(0.25);
    });
});

describe("transferLabel", () => {
    it("names the file whose transfer started last, with the direction", () => {
        const p = new SyncProgressTracker(() => 0);
        p.begin("manual-sync");
        expect(transferLabel(p.snapshot())).toBeNull();
        p.fileStarted("pull", "notes/sub/Meeting.md", 10);
        expect(transferLabel(p.snapshot())).toBe("↓ Meeting");
        p.fileStarted("push", "assets/photo.png", 10);
        expect(transferLabel(p.snapshot())).toBe("↑ photo.png");
    });

    it("keeps the name after a small file is through, until the next cycle", () => {
        const p = new SyncProgressTracker(() => 0);
        p.begin("modify-sync");
        p.fileStarted("push", "Daily.md", 10);
        p.fileFinished("push", "Daily.md");
        expect(p.snapshot().current).toEqual([]);
        expect(transferLabel(p.snapshot())).toBe("↑ Daily");
        p.finish("ok");
        p.begin("timer-sync");
        expect(transferLabel(p.snapshot())).toBeNull();
    });

    it("cuts a long name, counting characters and not code units", () => {
        const long = "議事録".repeat(20) + ".md";
        const label = transferLabel({ recent: { path: `a/${long}`, direction: "pull" } })!;
        expect(Array.from(label.slice(2))).toHaveLength(TRANSFER_NAME_MAX);
        expect(label.endsWith("…")).toBe(true);
        const emoji = transferLabel({ recent: { path: "😀".repeat(40), direction: "push" } }, 5)!;
        expect(emoji).toBe("↑ 😀😀😀😀…");
    });

    it("keeps a file that is named only by its extension", () => {
        expect(transferLabel({ recent: { path: ".md", direction: "push" } })).toBe("↑ .md");
    });
});
