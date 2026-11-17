/**
 * Vault storage backends for simulated devices.
 *
 * - "linux":   case-sensitive, byte-exact names (in memory)
 * - "windows": case-insensitive, case-preserving (in memory, emulated)
 * - "macos":   case-insensitive + Unicode-normalization-insensitive (NFC == NFD),
 *              and names created by the OS come back in NFD (in memory, emulated)
 * - "real-fs": the runner's actual file system in a temp directory, so the CI
 *              OS matrix exercises real NTFS / APFS / ext4 behaviour.
 *
 * Mixing personalities in one simulation reproduces cross-OS problems
 * (e.g. a Linux device creating "Todo.md" and "todo.md") on any CI runner.
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { MockVaultAdapter } from "../helpers/mock-vault-adapter";

export type FsPersonality = "linux" | "windows" | "macos" | "real-fs";

interface Entry {
    /** Name as stored (case / normalization the FS reports back) */
    path: string;
    content: ArrayBuffer;
    mtime: number;
}

/**
 * In-memory vault with configurable name-equivalence rules.
 * Implements the same surface as MockVaultAdapter so MockVault / MockVaultOperations work on top.
 */
export class PersonalityVaultAdapter extends MockVaultAdapter {
    private entries = new Map<string, Entry>(); // key = folded path
    private dirs = new Map<string, string>(); // folded -> stored path

    constructor(
        private readonly personality: Exclude<FsPersonality, "real-fs">,
        private readonly now: () => number,
    ) {
        super();
    }

    private fold(path: string): string {
        let p = path;
        if (this.personality === "macos") p = p.normalize("NFD");
        if (this.personality !== "linux") p = p.toLowerCase();
        return p;
    }

    /** The name the OS hands back when you create `path` */
    private storedName(path: string): string {
        return this.personality === "macos" ? path.normalize("NFD") : path;
    }

    override async exists(path: string): Promise<boolean> {
        const k = this.fold(path);
        return this.entries.has(k) || this.dirs.has(k);
    }

    override async readBinary(path: string): Promise<ArrayBuffer> {
        const e = this.entries.get(this.fold(path));
        if (!e) throw new Error(`File not found: ${path}`);
        return e.content.slice(0);
    }

    override async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
        const k = this.fold(path);
        const existing = this.entries.get(k);
        this.entries.set(k, {
            // Case-preserving: overwriting keeps the ORIGINAL name, like NTFS/APFS
            path: existing?.path ?? this.storedName(path),
            content: content.slice(0),
            mtime: this.now(),
        });
    }

    override statSync(path: string) {
        const k = this.fold(path);
        const e = this.entries.get(k);
        if (e) return { mtime: e.mtime, size: e.content.byteLength, ctime: e.mtime, type: "file" as const };
        if (this.dirs.has(k)) return { mtime: this.now(), size: 0, ctime: this.now(), type: "folder" as const };
        return null;
    }

    override async rename(from: string, to: string): Promise<void> {
        const fk = this.fold(from);
        if (this.dirs.has(fk)) {
            const fromPrefix = this.dirs.get(fk)! + "/";
            for (const [k, e] of [...this.entries]) {
                if (e.path.startsWith(fromPrefix) || this.fold(e.path).startsWith(fk + "/")) {
                    const np = to + "/" + e.path.slice(fromPrefix.length);
                    this.entries.delete(k);
                    this.entries.set(this.fold(np), { ...e, path: this.storedName(np) });
                }
            }
            for (const [k, p] of [...this.dirs]) {
                if (k === fk || k.startsWith(fk + "/")) {
                    this.dirs.delete(k);
                    const np = to + p.slice(this.dirs.get(fk)?.length ?? from.length);
                    this.dirs.set(this.fold(np), this.storedName(np));
                }
            }
            this.dirs.set(this.fold(to), this.storedName(to));
            return;
        }
        const e = this.entries.get(fk);
        if (!e) throw new Error(`File not found for rename: ${from}`);
        this.entries.delete(fk);
        // Case-only rename on a case-insensitive FS is allowed and updates the stored name
        this.entries.set(this.fold(to), { ...e, path: this.storedName(to) });
    }

    override async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const base = path === "/" || path === "" ? "" : this.fold(path) + "/";
        const files: string[] = [];
        const folders: string[] = [];
        for (const [k, e] of this.entries) {
            if (k.startsWith(base) && !k.slice(base.length).includes("/")) {
                files.push(e.path.split("/").pop()!);
            }
        }
        for (const [k, p] of this.dirs) {
            if (k.startsWith(base) && k !== base.slice(0, -1) && !k.slice(base.length).includes("/")) {
                folders.push(p.split("/").pop()!);
            }
        }
        return { files, folders };
    }

    override async mkdir(path: string): Promise<void> {
        const k = this.fold(path);
        if (!this.dirs.has(k)) this.dirs.set(k, this.storedName(path));
    }

    override async remove(path: string): Promise<void> {
        const k = this.fold(path);
        if (this.dirs.has(k)) {
            for (const ek of [...this.entries.keys()]) if (ek.startsWith(k + "/")) this.entries.delete(ek);
            for (const dk of [...this.dirs.keys()]) if (dk.startsWith(k + "/")) this.dirs.delete(dk);
            this.dirs.delete(k);
            return;
        }
        this.entries.delete(k);
    }

    override setFile(path: string, content: string, mtime?: number): void {
        const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
        this.entries.set(this.fold(path), { path: this.storedName(path), content: buf, mtime: mtime ?? this.now() });
    }

    override getContent(path: string): string | null {
        const e = this.entries.get(this.fold(path));
        return e ? new TextDecoder().decode(e.content) : null;
    }

    override hasFile(path: string): boolean {
        return this.entries.has(this.fold(path));
    }

    override listAllFiles(): string[] {
        return [...this.entries.values()].map((e) => e.path);
    }
}

/**
 * Vault backed by the real file system of the machine running the tests.
 */
export class RealFsVaultAdapter extends MockVaultAdapter {
    readonly root: string;
    /** Virtual-clock mtimes (the real FS clock would break determinism) */
    private mtimes = new Map<string, number>();

    constructor(label: string, private readonly now: () => number) {
        super();
        this.root = mkdtempSync(join(tmpdir(), `vault-sim-${label}-`));
    }

    private abs(path: string): string {
        return join(this.root, ...path.split("/").filter(Boolean));
    }

    override async exists(path: string): Promise<boolean> {
        return existsSync(this.abs(path));
    }
    override async readBinary(path: string): Promise<ArrayBuffer> {
        const b = readFileSync(this.abs(path));
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }
    override async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
        const p = this.abs(path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, Buffer.from(content));
        this.mtimes.set(path, this.now());
    }
    override statSync(path: string) {
        if (!existsSync(this.abs(path))) return null;
        const s = statSync(this.abs(path));
        return {
            // mtimes follow the virtual clock, not the wall clock
            mtime: this.mtimes.get(path) ?? 0,
            size: s.isDirectory() ? 0 : s.size,
            ctime: this.mtimes.get(path) ?? 0,
            type: s.isDirectory() ? ("folder" as const) : ("file" as const),
        };
    }
    override async rename(from: string, to: string): Promise<void> {
        const t = this.abs(to);
        mkdirSync(dirname(t), { recursive: true });
        renameSync(this.abs(from), t);
        const m = this.mtimes.get(from);
        if (m !== undefined) this.mtimes.set(to, m);
    }
    override async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const dir = path === "/" || path === "" ? this.root : this.abs(path);
        if (!existsSync(dir)) return { files: [], folders: [] };
        const files: string[] = [];
        const folders: string[] = [];
        for (const d of readdirSync(dir, { withFileTypes: true })) {
            (d.isDirectory() ? folders : files).push(d.name);
        }
        return { files, folders };
    }
    override async mkdir(path: string): Promise<void> {
        mkdirSync(this.abs(path), { recursive: true });
    }
    override async remove(path: string): Promise<void> {
        rmSync(this.abs(path), { recursive: true, force: true });
    }
    override setFile(path: string, content: string): void {
        const p = this.abs(path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
    }
    override getContent(path: string): string | null {
        const p = this.abs(path);
        if (!existsSync(p) || statSync(p).isDirectory()) return null;
        return readFileSync(p, "utf8");
    }
    override hasFile(path: string): boolean {
        const p = this.abs(path);
        return existsSync(p) && !statSync(p).isDirectory();
    }
    override listAllFiles(): string[] {
        const out: string[] = [];
        const walk = (dir: string, prefix: string) => {
            for (const d of readdirSync(dir, { withFileTypes: true })) {
                const rel = prefix ? `${prefix}/${d.name}` : d.name;
                if (d.isDirectory()) walk(join(dir, d.name), rel);
                else out.push(rel);
            }
        };
        walk(this.root, "");
        return out;
    }
    dispose(): void {
        rmSync(this.root, { recursive: true, force: true });
    }
}
