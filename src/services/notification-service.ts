import { Notice } from "obsidian";

export interface NoticeOptions {
    /** Keep the notice until the user dismisses it. */
    sticky?: boolean;
    /** Vault path to open when the notice is clicked. */
    openPath?: string;
}

export interface INotificationService {
    show(message: string, options?: NoticeOptions): void;
}

export class ObsidianNotificationService implements INotificationService {
    constructor(private openPath?: (path: string) => void) {}

    show(message: string, options?: NoticeOptions): void {
        try {
            const notice = options?.sticky ? new Notice(message, 0) : new Notice(message);
            const target = options?.openPath;
            if (target && this.openPath) {
                const el = notice.messageEl;
                el.addClass("vault-syncer-notice-link");
                // Obsidian dismisses the notice on click; open the file as well.
                el.addEventListener("click", () => this.openPath?.(target));
            }
        } catch {
            // Silently fail if Notice constructor throws
        }
    }
}
