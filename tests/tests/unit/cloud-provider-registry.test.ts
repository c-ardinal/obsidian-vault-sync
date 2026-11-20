import { describe, it, expect } from "vitest";
import {
    CloudProviderRegistry,
    cloudProviders,
    createCloudAdapter,
    DEFAULT_CLOUD_PROVIDER,
    googleDriveProvider,
    type CloudProviderDescriptor,
} from "../../../src/cloud-adapters";
import { testCapabilities } from "../../helpers/mock-cloud-adapter";

describe("cloud provider registry", () => {
    it("offers Google Drive as the default provider", () => {
        expect(DEFAULT_CLOUD_PROVIDER).toBe("google-drive");
        expect(cloudProviders.defaultProvider).toBe(googleDriveProvider);
        expect(cloudProviders.list().map((p) => p.id)).toContain("google-drive");
    });

    it("every registered provider builds an adapter that declares what its descriptor says", () => {
        for (const p of cloudProviders.list()) {
            const adapter = p.create("Vault", "Root");
            expect(adapter.capabilities, p.id).toEqual(p.capabilities);
            expect(adapter.vaultName).toBe("Vault");
        }
    });

    it("falls back to the default provider for a stored id this build does not have", () => {
        expect(cloudProviders.resolve("no-such-cloud")).toBe(googleDriveProvider);
        expect(cloudProviders.resolve(undefined)).toBe(googleDriveProvider);
        expect(createCloudAdapter("no-such-cloud", "V", "R").name).toBe(
            googleDriveProvider.create("V", "R").name,
        );
    });

    it("rejects an unknown id on get() and a second registration of the same id", () => {
        const reg = new CloudProviderRegistry("google-drive").register(googleDriveProvider);
        expect(() => reg.get("dropbox")).toThrow(/Unknown cloud provider/);
        expect(() => reg.register(googleDriveProvider)).toThrow(/registered twice/);
    });

    it("a new provider is added by registering a descriptor, nothing else", () => {
        const fake: CloudProviderDescriptor = {
            id: "google-drive",
            displayName: "Fake",
            capabilities: testCapabilities(),
            create: () => ({ capabilities: testCapabilities() }) as never,
        };
        const reg = new CloudProviderRegistry("google-drive").register(fake);
        expect(reg.resolve("google-drive").displayName).toBe("Fake");
    });
});
