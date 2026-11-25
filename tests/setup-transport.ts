/**
 * In the app, Drive requests go out over XMLHttpRequest (xhr-request.ts). Node
 * has none, and the tests mock the network by stubbing the global fetch, so
 * route requests there; xhr-request.test.ts covers the XMLHttpRequest side.
 */
import { GoogleDriveHttpClient } from "../src/cloud-adapters/google-drive/http-client";

GoogleDriveHttpClient.transport = (url, init) => fetch(url, init);
