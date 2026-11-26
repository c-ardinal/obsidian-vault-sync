/**
 * The parts of "obsidian" that the Drive adapter, the add-on loader and the add-on
 * engine import, for the browser bundle of these tests. Nothing here is drawn.
 */
export function requestUrl(): never {
    throw new Error("requestUrl is not available in the browser tests");
}
export function normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
class Component {
    [key: string]: unknown;
    constructor(..._args: unknown[]) {}
}
export class Modal extends Component {
    open(): void {}
    close(): void {}
}
export class Setting extends Component {}
export class Notice extends Component {}
export class ButtonComponent extends Component {}
export class TextAreaComponent extends Component {}
export const Platform = { isMobile: false, isDesktop: true };
