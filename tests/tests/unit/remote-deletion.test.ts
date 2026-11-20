import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
    RemoteDeletionService,
    immediateRemoteDeletion,
    removeRemote,
    type RemoteDeletionStrategy,
} from "../../../src/sync-manager/remote-deletion";
import type { CloudAdapter } from "../../../src/types/adapter";

function fakeAdapter() {
    return { deleteFile: vi.fn(async () => {}) } as unknown as CloudAdapter & {
        deleteFile: ReturnType<typeof vi.fn>;
    };
}

describe("RemoteDeletionService", () => {
    it("removes at once through the adapter by default", async () => {
        const adapter = fakeAdapter();
        const service = new RemoteDeletionService();
        await service.remove(adapter, { id: "f1", path: "a.md", kind: "file" }, "user-file");
        expect(adapter.deleteFile).toHaveBeenCalledWith("f1");
    });

    it("tells listeners what was removed and why", async () => {
        const adapter = fakeAdapter();
        const service = new RemoteDeletionService(immediateRemoteDeletion, () => 1234);
        const seen: unknown[] = [];
        service.onRemoved((r) => seen.push(r));
        await service.remove(adapter, { id: "d1", path: "notes", kind: "folder" }, "user-folder");
        expect(seen).toEqual([
            { id: "d1", path: "notes", kind: "folder", reason: "user-folder", at: 1234 },
        ]);
    });

    it("does not notify when the removal fails, and passes the error on", async () => {
        const adapter = fakeAdapter();
        adapter.deleteFile.mockRejectedValueOnce(new Error("offline"));
        const service = new RemoteDeletionService();
        const listener = vi.fn();
        service.onRemoved(listener);
        await expect(
            service.remove(adapter, { id: "f1", path: "a.md" }, "user-file"),
        ).rejects.toThrow("offline");
        expect(listener).not.toHaveBeenCalled();
    });

    it("keeps a removal done when a listener throws", async () => {
        const adapter = fakeAdapter();
        const service = new RemoteDeletionService();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        service.onRemoved(() => {
            throw new Error("listener bug");
        });
        await expect(
            service.remove(adapter, { id: "f1", path: "a.md" }, "user-file"),
        ).resolves.toBeUndefined();
        errSpy.mockRestore();
    });

    it("stops notifying after unsubscribing", async () => {
        const service = new RemoteDeletionService();
        const listener = vi.fn();
        const off = service.onRemoved(listener);
        off();
        await service.remove(fakeAdapter(), { id: "f1", path: "a.md" }, "user-file");
        expect(listener).not.toHaveBeenCalled();
    });

    it("uses a swapped strategy instead of deleting", async () => {
        const adapter = fakeAdapter();
        const strategy: RemoteDeletionStrategy = { remove: vi.fn(async () => {}) };
        const service = new RemoteDeletionService();
        service.setStrategy(strategy);
        await service.remove(adapter, { id: "f1", path: "a.md" }, "excluded-cleanup");
        expect(strategy.remove).toHaveBeenCalledWith(
            adapter,
            { id: "f1", path: "a.md" },
            "excluded-cleanup",
        );
        expect(adapter.deleteFile).not.toHaveBeenCalled();
    });

    it("removeRemote uses the context's service and adapter", async () => {
        const adapter = fakeAdapter();
        const service = new RemoteDeletionService();
        const spy = vi.spyOn(service, "remove");
        await removeRemote(
            { adapter, remoteDeletion: service },
            { id: "f1", path: "a.md" },
            "user-file",
        );
        expect(spy).toHaveBeenCalledWith(adapter, { id: "f1", path: "a.md" }, "user-file");
        expect(adapter.deleteFile).toHaveBeenCalledWith("f1");
    });

    it("removeRemote works for contexts without a service", async () => {
        const adapter = fakeAdapter();
        await removeRemote({ adapter }, { id: "f9", path: "b.md" }, "user-file");
        expect(adapter.deleteFile).toHaveBeenCalledWith("f9");
    });
});

describe("remote removals have one entry point", () => {
    function sourceFiles(dir: string): string[] {
        return readdirSync(dir).flatMap((name) => {
            const p = join(dir, name);
            return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
        });
    }

    it("only adapters and the deletion service call deleteFile()", () => {
        const allowed = [
            join("src", "sync-manager", "remote-deletion.ts"),
            join("src", "cloud-adapters"),
            join("src", "encryption", "encrypted-adapter.ts"),
            join("src", "types", "adapter.ts"),
        ];
        const offenders = sourceFiles("src")
            .filter((f) => !allowed.some((a) => f.startsWith(a)))
            .filter((f) => /\.deleteFile\(/.test(readFileSync(f, "utf8")));
        expect(offenders).toEqual([]);
    });
});

describe("the plugin shell names no concrete cloud adapter", () => {
    it("only src/cloud-adapters imports a provider's adapter", () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (p.endsWith(".ts")) files.push(p);
            }
        };
        walk("src");
        const offenders = files
            .filter((f) => !f.startsWith(join("src", "cloud-adapters")))
            .filter((f) => /from\s+["'][^"']*cloud-adapters\/google-drive/.test(readFileSync(f, "utf8")));
        expect(offenders).toEqual([]);
    });
});
