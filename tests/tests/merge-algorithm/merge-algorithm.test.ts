/**
 * Fixture-based 3-way merge algorithm tests.
 *
 * Test cases are auto-discovered from tests/merge-algorithm/scenarios/ directory.
 * Each case folder contains:
 *   base.*       - Common ancestor content
 *   remote.*     - Remote (cloud) version
 *   local.*      - Local version
 *   expected.*   - Expected merge result (if absent, merge should fail → null)
 *
 * To add a new test case, simply create a new folder with these files.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockCloudAdapter } from "../../helpers/mock-cloud-adapter";
import { DeviceSimulator } from "../../helpers/device-simulator";
import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.resolve(__dirname, "scenarios");

/** Discover all test cases from fixture directories */
function discoverCases(): {
    name: string;
    dir: string;
    ext: string;
    hasExpected: boolean;
}[] {
    const cases: { name: string; dir: string; ext: string; hasExpected: boolean }[] = [];

    if (!fs.existsSync(FIXTURES_DIR)) return cases;

    for (const entry of fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const caseDir = path.join(FIXTURES_DIR, entry.name);
        const files = fs.readdirSync(caseDir);

        // Find base file to determine extension
        const baseFile = files.find((f) => f.startsWith("base."));
        if (!baseFile) continue;

        const ext = path.extname(baseFile); // e.g. ".md", ".go", ".png"
        const hasRemote = files.some((f) => f === `remote${ext}`);
        const hasLocal = files.some((f) => f === `local${ext}`);
        const hasExpected = files.some((f) => f === `expected${ext}`);

        if (!hasRemote || !hasLocal) continue;

        cases.push({
            name: entry.name,
            dir: caseDir,
            ext,
            hasExpected,
        });
    }

    return cases.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read fixture file as string (normalize CRLF → LF to match merge output) */
function readFixture(dir: string, filename: string): string {
    return fs.readFileSync(path.join(dir, filename), "utf-8").replace(/\r\n/g, "\n");
}

/** Check if extension is likely binary (not text-mergeable) */
function isBinaryExtension(ext: string): boolean {
    const binaryExts = new Set([
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".bmp",
        ".webp",
        ".svg",
        ".ico",
        ".mp3",
        ".wav",
        ".ogg",
        ".mp4",
        ".webm",
        ".mov",
        ".pdf",
        ".zip",
        ".tar",
        ".gz",
        ".exe",
        ".dll",
        ".so",
        ".dylib",
    ]);
    return binaryExts.has(ext.toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════
// Auto-discovered fixture-based merge tests
// ═══════════════════════════════════════════════════════════════════

const cases = discoverCases();

describe("3-way merge algorithm (fixture-based)", () => {
    let cloud: MockCloudAdapter;
    let device: DeviceSimulator;

    beforeEach(async () => {
        cloud = new MockCloudAdapter();
        device = new DeviceSimulator("TestDevice", cloud, "dev_test");
    });

    if (cases.length === 0) {
        it.skip("no fixture cases found", () => {});
    }

    for (const tc of cases) {
        // Binary cases are tested via pullFileSafely (extension filtering)
        if (isBinaryExtension(tc.ext)) continue;

        const label = tc.hasExpected
            ? `${tc.name} (${tc.ext}) → merge success`
            : `${tc.name} (${tc.ext}) → merge fail (null)`;

        it(label, async () => {
            console.log(`\n── ${tc.name} ──`);

            // Read fixture files
            const baseContent = readFixture(tc.dir, `base${tc.ext}`);
            const remoteContent = readFixture(tc.dir, `remote${tc.ext}`);
            const localContent = readFixture(tc.dir, `local${tc.ext}`);

            console.log(`  base:   ${baseContent.substring(0, 80).replace(/\n/g, "\\n")}...`);
            console.log(`  remote: ${remoteContent.substring(0, 80).replace(/\n/g, "\\n")}...`);
            console.log(`  local:  ${localContent.substring(0, 80).replace(/\n/g, "\\n")}...`);

            // Upload base to cloud (creates revision for lookup)
            const filePath = `test${tc.ext}`;
            const baseBuf = new TextEncoder().encode(baseContent).buffer as ArrayBuffer;
            await cloud.uploadFile(filePath, baseBuf, Date.now());
            const baseHash = cloud.getCloudHash(filePath)!;

            // Call perform3WayMerge directly (private method)
            const sm = device.syncManager;
            const result: ArrayBuffer | null = await (sm as any).perform3WayMerge(
                filePath,
                localContent,
                remoteContent,
                baseHash,
            );

            try {
                if (tc.hasExpected) {
                    // Expected: merge succeeds
                    const expectedContent = readFixture(tc.dir, `expected${tc.ext}`);
                    expect(result).not.toBeNull();
                    const merged = new TextDecoder().decode(result!);
                    console.log(`  merged: ${merged.substring(0, 80).replace(/\n/g, "\\n")}...`);
                    console.log(
                        `  expect: ${expectedContent.substring(0, 80).replace(/\n/g, "\\n")}...`,
                    );
                    expect(merged).toBe(expectedContent);
                    console.log(`  ✓ Merge matches expected`);
                } else {
                    // Expected: merge fails (returns null)
                    expect(result).toBeNull();
                    console.log(`  ✓ Merge correctly returned null`);
                }
            } catch (err) {
                console.log("\n--- MERGE LOGS ---");
                console.log(device.logs.join("\n"));
                console.log("------------------\n");
                throw err;
            }
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
// Extension filtering test (binary/unsupported files)
// ═══════════════════════════════════════════════════════════════════

const binaryCases = cases.filter((tc) => isBinaryExtension(tc.ext));

if (binaryCases.length > 0) {
    describe("Merge extension filtering (binary rejection)", () => {
        let cloud: MockCloudAdapter;
        let device: DeviceSimulator;

        beforeEach(async () => {
            cloud = new MockCloudAdapter();
            device = new DeviceSimulator("TestDevice", cloud, "dev_test");
        });

        for (const tc of binaryCases) {
            it(`${tc.name} (${tc.ext}) → should reject merge for binary file`, async () => {
                console.log(`\n── ${tc.name} (binary rejection) ──`);

                // Create a minimal binary file scenario
                const filePath = `test${tc.ext}`;
                const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer as ArrayBuffer;

                // Upload to cloud
                await cloud.uploadFile(filePath, content, Date.now());
                const fileId = cloud.getFileId(filePath)!;

                // Setup synced state
                const hash = cloud.getCloudHash(filePath)!;
                const sm = device.syncManager;
                const entry = {
                    fileId,
                    mtime: Date.now(),
                    size: 4,
                    hash,
                    lastAction: "pull" as const,
                    ancestorHash: hash,
                };
                (sm as any).index[filePath] = { ...entry };
                (sm as any).localIndex[filePath] = { ...entry };

                // Upload different content as "remote update"
                const remoteContent = new Uint8Array([0x89, 0x50, 0x4e, 0x48])
                    .buffer as ArrayBuffer;
                await cloud.uploadFile(filePath, remoteContent, Date.now());

                // Write different local content
                device.app.vaultAdapter.setFile(filePath, "different");
                (sm as any).dirtyPaths.set(filePath, Date.now());

                // Pull should NOT attempt merge (isText=false for binary extensions)
                const remoteMeta = await cloud.getFileMetadata(filePath);
                const result = await (sm as any).pullFileSafely(remoteMeta!, true, "Test");

                // Binary files should create conflict file, not merge
                const allFiles = device.listLocalFiles();
                const conflictFiles = allFiles.filter((f) => f.includes("Conflict"));
                console.log(
                    `  Conflict files: ${conflictFiles.length > 0 ? conflictFiles.join(", ") : "none"}`,
                );

                // Either pull succeeded (accepted remote) or conflict file created
                // The key point: no 3-way merge was attempted
                const mergeLogs = device.logs.filter((l) => l.includes("[Merge]"));
                expect(mergeLogs.length).toBe(0);
                console.log(`  ✓ No merge attempted for binary file`);
            });
        }
    });
}
