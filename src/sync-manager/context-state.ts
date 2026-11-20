/**
 * State that sync modules keep per sync context, outside the SyncContext
 * interface (pending repairs, journal, rename echoes, ...).
 *
 * Each module used to hold its own WeakMap keyed by the context, so nobody
 * could tell how much state a context carries or find all of it. Every such
 * piece is now declared here through CtxState / CtxFlag: it has a name and a
 * one-line description, is listed by ctxStateCatalog(), and its current size
 * is shown by describeCtxState() (debug logs, support info).
 *
 * The API is the WeakMap / WeakSet one, so the modules' code is unchanged.
 * The state lives as long as the context object; nothing here is persisted.
 */

interface Registered {
    name: string;
    about: string;
    read(ctx: object): unknown;
}

const registry = new Map<string, Registered>();

function register(entry: Registered): void {
    if (registry.has(entry.name)) throw new Error(`Context state "${entry.name}" is declared twice`);
    registry.set(entry.name, entry);
}

/** A value per sync context (WeakMap API) */
export class CtxState<V> {
    private readonly values = new WeakMap<object, V>();

    constructor(
        readonly name: string,
        readonly about: string,
    ) {
        register({ name, about, read: (ctx) => this.values.get(ctx) });
    }

    get(ctx: object): V | undefined {
        return this.values.get(ctx);
    }

    set(ctx: object, value: V): this {
        this.values.set(ctx, value);
        return this;
    }

    has(ctx: object): boolean {
        return this.values.has(ctx);
    }

    delete(ctx: object): boolean {
        return this.values.delete(ctx);
    }
}

/** A yes/no mark per sync context (WeakSet API) */
export class CtxFlag {
    private readonly marked = new WeakSet<object>();

    constructor(
        readonly name: string,
        readonly about: string,
    ) {
        register({ name, about, read: (ctx) => (this.marked.has(ctx) ? true : undefined) });
    }

    has(ctx: object): boolean {
        return this.marked.has(ctx);
    }

    add(ctx: object): this {
        this.marked.add(ctx);
        return this;
    }

    delete(ctx: object): boolean {
        return this.marked.delete(ctx);
    }
}

/** Every declared piece of per-context state, by name */
export function ctxStateCatalog(): { name: string; about: string }[] {
    return [...registry.values()].map(({ name, about }) => ({ name, about })).sort((a, b) => a.name.localeCompare(b.name));
}

function summarize(value: unknown): string {
    if (value instanceof Map || value instanceof Set) return `${value.size} item(s)`;
    if (Array.isArray(value)) return `${value.length} item(s)`;
    if (value === null || typeof value !== "object") return String(value);
    return `${Object.keys(value).length} field(s)`;
}

/** What a context currently carries: name -> short summary (only states that are set) */
export function describeCtxState(ctx: object): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const value = entry.read(ctx);
        if (value !== undefined) out[entry.name] = summarize(value);
    }
    return out;
}
