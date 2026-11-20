import type { OAuthCloudAdapter } from "../types/oauth-adapter";
import { GoogleDriveAdapter } from "./google-drive";

/** Cloud providers this build can connect to. */
export type CloudProviderId = "google-drive";

export const DEFAULT_CLOUD_PROVIDER: CloudProviderId = "google-drive";

/**
 * The one place that names concrete adapter classes. Everything else works with
 * the adapter interfaces, so adding a provider means adding a case here (and,
 * later, its settings and sign-in screen) rather than editing the plugin shell.
 */
export function createCloudAdapter(
    provider: CloudProviderId,
    vaultName: string,
    cloudRootFolder: string,
): OAuthCloudAdapter {
    switch (provider) {
        case "google-drive":
            // App credentials and tokens are applied after settings load.
            return new GoogleDriveAdapter("", "", vaultName, cloudRootFolder);
    }
}
