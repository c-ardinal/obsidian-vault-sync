/**
 * @file 同期計画（SyncPlan）と確認処理（PlanGuard）
 *
 * @description
 * 削除・上書きは実行前に一つの計画として集計され、確認処理が承認したものだけが実行される。
 *
 * @pass_criteria
 * - 送信時、フォルダー削除・ファイル削除・上書きが一つの計画に入り、確認前には何も削除されない
 * - フォルダー削除の計画には、そのフォルダー内の同期済みファイルが含まれる
 * - 保留された削除・上書きは実行されず、変更済みの印が残る（次回同期で再計画）
 * - 受信時、保留された他端末の削除ではローカルファイルが残り、再アップロード対象になる
 * - 既定の確認処理はすべて承認する（従来どおりの動作）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator } from "../../helpers/device-simulator";
import { smartPush } from "../../../src/sync-manager/sync-push";
import { pullViaChangesAPI } from "../../../src/sync-manager/sync-pull";
import { markDeleted, markFolderDeleted } from "../../../src/sync-manager/state";
import {
    PlanDecision,
    approveAllPlanGuard,
    reviewPlan,
    summarizePlan,
    type PlanGuard,
    type SyncPlan,
} from "../../../src/sync-manager/sync-plan";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("SyncPlan building blocks", () => {
    const plan: SyncPlan = {
        step: "push",
        changes: [
            { action: "delete-remote", path: "f", kind: "folder", contains: ["f/a.md", "f/b.md"] },
            { action: "delete-remote", path: "c.md", kind: "file" },
            { action: "overwrite-remote", path: "d.md", kind: "file" },
            { action: "delete-local", path: "e.md", kind: "file" },
        ],
    };

    it("counts the files inside removed folders as removed files", () => {
        expect(summarizePlan(plan)).toEqual({
            remoteFilesDeleted: 3,
            remoteFoldersDeleted: 1,
            remoteFilesOverwritten: 1,
            localFilesDeleted: 1,
        });
    });

    it("a decision holds exactly the named changes", () => {
        const d = new PlanDecision(["delete-remote\u0000c.md"]);
        expect(d.allows("delete-remote", "c.md")).toBe(false);
        expect(d.allows("overwrite-remote", "c.md")).toBe(true);
        expect(d.allows("delete-remote", "unplanned.md")).toBe(true);
        expect(PlanDecision.holdAll(plan).heldCount).toBe(4);
    });

    it("an empty plan is not shown to the guard", async () => {
        const guard = { review: vi.fn(async () => PlanDecision.approveAll()) };
        await reviewPlan({ planGuard: guard }, { step: "pull", changes: [] });
        expect(guard.review).not.toHaveBeenCalled();
    });

    it("the default guard approves everything", async () => {
        const d = await approveAllPlanGuard.review(plan);
        expect(d.heldCount).toBe(0);
    });
});

describe("push: plan -> review -> execute", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;
    let sm: any;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("A", cloud);
        sm = device.getContext();

        // A folder with two synced notes, deleted on this device
        cloud.addFakeFolder("old");
        for (const name of ["old/a.md", "old/b.md"]) {
            const up = await cloud.uploadFile(name, enc(name), Date.now());
            device.setupSyncedFile(name, name, up.id);
            await device.app.vaultAdapter.remove(name);
            sm.dirtyPaths.set(name, Date.now());
        }
        markFolderDeleted(sm, "old");

        // A single deleted note
        const gone = await cloud.uploadFile("gone.md", enc("bye"), Date.now());
        device.setupSyncedFile("gone.md", "bye", gone.id);
        await device.app.vaultAdapter.remove("gone.md");
        markDeleted(sm, "gone.md");

        // An edited note (overwrites the cloud copy)
        const kept = await cloud.uploadFile("kept.md", enc("v1"), Date.now());
        device.setupSyncedFile("kept.md", "v1", kept.id);
        device.editFile("kept.md", "v2");
    });

    it("shows the guard the whole push before anything is removed", async () => {
        const deletesBeforeReview: number[] = [];
        const deleteSpy = vi.spyOn(cloud, "deleteFile");
        let seen: SyncPlan | undefined;
        sm.planGuard = {
            review: async (plan: SyncPlan) => {
                seen = plan;
                deletesBeforeReview.push(deleteSpy.mock.calls.length);
                return PlanDecision.approveAll();
            },
        } satisfies PlanGuard;

        await smartPush(sm, false);

        expect(deletesBeforeReview).toEqual([0]);
        expect(seen?.step).toBe("push");
        const byPath = new Map(seen!.changes.map((c) => [c.path, c]));
        expect(byPath.get("old")).toMatchObject({ action: "delete-remote", kind: "folder" });
        expect([...(byPath.get("old")!.contains ?? [])].sort()).toEqual(["old/a.md", "old/b.md"]);
        expect(byPath.get("gone.md")).toMatchObject({ action: "delete-remote", kind: "file" });
        expect(byPath.get("kept.md")).toMatchObject({ action: "overwrite-remote" });
        // Files inside the folder are covered by the folder, not listed one by one
        expect(byPath.has("old/a.md")).toBe(false);

        // Approved: everything ran as before
        expect(await cloud.getFileMetadata("old")).toBeNull();
        expect(await cloud.getFileMetadata("gone.md")).toBeNull();
        expect(cloud.getCloudContent("kept.md")).toBe("v2");
    });

    it("runs nothing the guard held, and plans it again next sync", async () => {
        sm.planGuard = { review: async (plan: SyncPlan) => PlanDecision.holdAll(plan) };

        await smartPush(sm, false);

        expect(await cloud.getFileMetadata("old")).not.toBeNull();
        expect(await cloud.getFileMetadata("gone.md")).not.toBeNull();
        expect(cloud.getCloudContent("kept.md")).toBe("v1");
        expect(sm.deletedFolders.has("old")).toBe(true);
        expect(sm.dirtyPaths.has("gone.md")).toBe(true);
        expect(sm.dirtyPaths.has("kept.md")).toBe(true);
        expect(sm.index["gone.md"]).toBeDefined();

        // Next sync with the default guard carries them out
        sm.planGuard = approveAllPlanGuard;
        markDeleted(sm, "gone.md");
        await smartPush(sm, false);
        expect(await cloud.getFileMetadata("old")).toBeNull();
        expect(await cloud.getFileMetadata("gone.md")).toBeNull();
        expect(cloud.getCloudContent("kept.md")).toBe("v2");
    });
});

describe("pull: a held deletion keeps the local file", () => {
    const PATH = "notes/shared.md";
    let cloud: MockCloudAdapter;
    let b: DeviceSimulator;
    let fileId: string;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        fileId = (await cloud.uploadFile(PATH, enc("v1\n"), Date.now())).id;
        b = new DeviceSimulator("B", cloud, "dev_B");
        b.setupSyncedFile(PATH, "v1\n", fileId);
        b.getContext().startPageToken = await cloud.getStartPageToken();
        await b.app.vaultAdapter.mkdir("notes");
    });

    it("keeps the note and marks it for upload when the guard holds the deletion", async () => {
        let seen: SyncPlan | undefined;
        b.getContext().planGuard = {
            review: async (plan: SyncPlan) => {
                seen = plan;
                return PlanDecision.holdAll(plan);
            },
        };
        await cloud.deleteFile(fileId); // another device deleted it

        await b.smartPull();

        expect(seen?.changes).toEqual([{ action: "delete-local", path: PATH, kind: "file" }]);
        expect(b.getLocalContent(PATH)).toBe("v1\n");
        expect(b.getDirtyPaths().has(PATH)).toBe(true);
        expect(b.getIndex(PATH)).toBeUndefined();
    });

    it("holds a deletion reported by the change feed the same way", async () => {
        const guard = { review: vi.fn(async (plan: SyncPlan) => PlanDecision.holdAll(plan)) };
        b.getContext().planGuard = guard;
        await cloud.deleteFile(fileId);

        await pullViaChangesAPI(b.getContext());

        expect(guard.review).toHaveBeenCalled();
        expect(b.getLocalContent(PATH)).toBe("v1\n");
        expect(b.getDirtyPaths().has(PATH)).toBe(true);
        expect(b.getIndex(PATH)).toBeUndefined();
    });

    it("applies the deletion with the default guard", async () => {
        await cloud.deleteFile(fileId);
        await b.smartPull();
        expect(b.getLocalContent(PATH)).toBeNull();
    });
});
