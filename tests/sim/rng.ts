/**
 * Small seeded PRNG (mulberry32) so every simulation run is reproducible
 * from a single integer seed.
 */
export class Rng {
    private state: number;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    /** Uniform float in [0, 1) */
    next(): number {
        let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** Integer in [min, max] (inclusive) */
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    chance(p: number): boolean {
        return this.next() < p;
    }

    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.next() * items.length)];
    }

    /** Pick a key from a weight table */
    weighted<K extends string>(weights: Record<K, number>): K {
        const entries = Object.entries(weights) as [K, number][];
        const total = entries.reduce((s, [, w]) => s + w, 0);
        let r = this.next() * total;
        for (const [k, w] of entries) {
            r -= w;
            if (r < 0) return k;
        }
        return entries[entries.length - 1][0];
    }

    /** Derive an independent stream (so engine randomness doesn't shift the scenario) */
    fork(salt: number): Rng {
        return new Rng((Math.imul(this.state ^ salt, 0x9e3779b1) >>> 0) || 1);
    }
}
