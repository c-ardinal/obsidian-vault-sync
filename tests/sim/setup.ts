/**
 * Determinism for the simulation: the plugin's gzip helpers use Web
 * CompressionStream, which completes in REAL time on a native thread. That
 * lets wall-clock speed leak into the virtual-time interleaving of devices.
 * Swap them for synchronous zlib (same gzip format) so a seed always replays
 * identically on every machine / OS.
 */
import { vi } from "vitest";
import { gzipSync, gunzipSync } from "zlib";

const toAB = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

vi.mock("../../src/sync-manager/file-utils", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../../src/sync-manager/file-utils")>();
    const mocked = {
        ...orig,
        compress: async (data: ArrayBuffer) => toAB(gzipSync(Buffer.from(data))),
        tryDecompress: async (data: ArrayBuffer) => {
            const v = new Uint8Array(data);
            if (v.length > 2 && v[0] === 0x1f && v[1] === 0x8b) return toAB(gunzipSync(Buffer.from(data)));
            return data;
        },
    };
    // The plugin folders are set after load (setPluginDir): read them from the module
    // each time, a copy made here would keep the values of the moment it was made.
    for (const name of ["PLUGIN_DIR", "LEGACY_PLUGIN_DIRS"] as const) {
        Object.defineProperty(mocked, name, { get: () => orig[name], enumerable: true });
    }
    return mocked;
});
