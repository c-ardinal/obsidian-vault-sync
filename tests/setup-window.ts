/**
 * The plugin calls timers through `window` (window.setTimeout etc.) as Obsidian
 * asks for popout-window support. Node has no `window`, so the test default is
 * globalThis itself: fake timers installed on globalThis then apply as well.
 */
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
    (globalThis as { window?: unknown }).window = globalThis;
}

/**
 * A window stub with the given properties that falls back to globalThis for
 * everything else (timers above all), looked up at call time so fake timers
 * installed later still apply.
 */
export function windowStub<T extends object>(props: T): T & typeof globalThis {
    return Object.create(globalThis, Object.getOwnPropertyDescriptors(props)) as T & typeof globalThis;
}
