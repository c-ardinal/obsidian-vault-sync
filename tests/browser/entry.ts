/**
 * Browser bundle for the tests in this folder: the real Drive adapter, its HTTP
 * client, the XMLHttpRequest transport and the add-on loader, as the plugin ships them. Only the
 * host is rewritten, so requests for Google go to the local test server (on
 * another origin, so the browser applies CORS like it does for googleapis.com).
 */
import { GoogleDriveAdapter } from "../../src/cloud-adapters/google-drive/index";
import { GoogleDriveHttpClient } from "../../src/cloud-adapters/google-drive/http-client";
import { xhrRequest } from "../../src/cloud-adapters/google-drive/xhr-request";
import { evaluateEngine } from "../../src/encryption/engine-loader";

declare global {
    interface Window {
        driveTest: {
            makeAdapter: (apiOrigin: string) => GoogleDriveAdapter;
            GoogleDriveHttpClient: typeof GoogleDriveHttpClient;
            xhrRequest: typeof xhrRequest;
            evaluateEngine: typeof evaluateEngine;
        };
    }
}

window.driveTest = {
    makeAdapter(apiOrigin: string) {
        GoogleDriveHttpClient.transport = (url, init, options) => {
            const u = new URL(url);
            return xhrRequest(`${apiOrigin}/__host/${u.host}${u.pathname}${u.search}`, init, options);
        };
        const adapter = new GoogleDriveAdapter("test-client-id", "test-secret", "BrowserVault", "BrowserRoot");
        adapter.auth.accessToken = "fake-access-token";
        adapter.auth.refreshToken = "fake-refresh-token";
        adapter.auth.tokenExpiresAt = Date.now() + 3600 * 1000;
        return adapter;
    },
    GoogleDriveHttpClient,
    xhrRequest,
    evaluateEngine,
};
