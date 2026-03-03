import { Notice } from "obsidian";

export interface INotificationService {
    show(message: string): void;
}

export class ObsidianNotificationService implements INotificationService {
    show(message: string): void {
        try {
            new Notice(message);
        } catch {
            // Silently fail if Notice constructor throws
        }
    }
}
