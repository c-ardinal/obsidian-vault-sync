import type { CloudCapabilities } from "../types/adapter";
import type { OAuthCloudAdapter } from "../types/oauth-adapter";
import { GoogleDriveAdapter, GOOGLE_DRIVE_CAPABILITIES } from "./google-drive";

/** Cloud providers this build can connect to. */
export type CloudProviderId = "google-drive";

/**
 * Everything the plugin needs to know about one cloud provider before an
 * adapter exists: its id (stored in settings), the name shown to the user,
 * what it can do, and how to build its adapter.
 */
export interface CloudProviderDescriptor {
    readonly id: CloudProviderId;
    /** Product name shown in the UI (not translated) */
    readonly displayName: string;
    readonly capabilities: CloudCapabilities;
    /** App credentials and tokens are applied after settings load. */
    create(vaultName: string, cloudRootFolder: string): OAuthCloudAdapter;
}

/**
 * The providers this build offers. Adding a provider means registering its
 * descriptor here; the plugin shell, settings and sync only see the registry
 * and the adapter interfaces.
 */
export class CloudProviderRegistry {
    private readonly providers = new Map<string, CloudProviderDescriptor>();

    constructor(private readonly defaultId: CloudProviderId) {}

    register(descriptor: CloudProviderDescriptor): this {
        if (this.providers.has(descriptor.id)) {
            throw new Error(`Cloud provider registered twice: ${descriptor.id}`);
        }
        this.providers.set(descriptor.id, descriptor);
        return this;
    }

    has(id: string): id is CloudProviderId {
        return this.providers.has(id);
    }

    get(id: string): CloudProviderDescriptor {
        const d = this.providers.get(id);
        if (!d) throw new Error(`Unknown cloud provider: ${id}`);
        return d;
    }

    /** The provider used when settings name none (or one this build does not have) */
    get defaultProvider(): CloudProviderDescriptor {
        return this.get(this.defaultId);
    }

    /** Resolve a stored provider id, falling back to the default for unknown ids */
    resolve(id: string | undefined | null): CloudProviderDescriptor {
        return id && this.has(id) ? this.get(id) : this.defaultProvider;
    }

    list(): CloudProviderDescriptor[] {
        return [...this.providers.values()];
    }
}

export const googleDriveProvider: CloudProviderDescriptor = {
    id: "google-drive",
    displayName: "Google Drive",
    capabilities: GOOGLE_DRIVE_CAPABILITIES,
    create: (vaultName, cloudRootFolder) => new GoogleDriveAdapter("", "", vaultName, cloudRootFolder),
};

export const cloudProviders = new CloudProviderRegistry("google-drive").register(googleDriveProvider);

export const DEFAULT_CLOUD_PROVIDER: CloudProviderId = cloudProviders.defaultProvider.id;

/** Build the adapter of a provider (the default one for an unknown id). */
export function createCloudAdapter(
    provider: string | undefined | null,
    vaultName: string,
    cloudRootFolder: string,
): OAuthCloudAdapter {
    return cloudProviders.resolve(provider).create(vaultName, cloudRootFolder);
}
