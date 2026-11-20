import { vi, beforeAll, afterAll } from "vitest";
import { describeAdapterContract } from "../../helpers/adapter-contract";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { driveAdapterOnFakeServer } from "../../helpers/fake-drive-server";

// The Drive client logs every non-ok answer (a 404 is an expected answer here)
let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeAll(() => {
    quiet = [
        vi.spyOn(console, "error").mockImplementation(() => {}),
        vi.spyOn(console, "debug").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
});
afterAll(() => quiet.forEach((s) => s.mockRestore()));

describeAdapterContract("MockCloudAdapter (test double)", () => {
    const adapter = new MockCloudAdapter();
    return { adapter, setChangesPageSize: (n) => (adapter.changesPageSize = n) };
});

describeAdapterContract("GoogleDriveAdapter (fake Drive v3 server)", () => {
    const { adapter, server } = driveAdapterOnFakeServer();
    return { adapter, setChangesPageSize: (n) => (server.changesPageSize = n) };
});
