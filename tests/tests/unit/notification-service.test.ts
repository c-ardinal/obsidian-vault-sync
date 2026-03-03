/**
 * @file NotificationService ユニットテスト
 *
 * @description
 * ObsidianNotificationService のshowメソッド、エラーハンドリング、
 * 様々なメッセージタイプの処理を検証する。
 *
 * @pass_criteria
 * - show: 正常にNoticeを表示
 * - error handling: Noticeコンストラクタが例外を投げた場合の処理
 * - message types: 空文字、通常文字列、特殊文字を含む文字列
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObsidianNotificationService, INotificationService } from "../../../src/services/notification-service";
import { Notice } from "obsidian";

describe("ObsidianNotificationService", () => {
    let service: INotificationService;

    beforeEach(() => {
        service = new ObsidianNotificationService();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("show", () => {
        it("should display a notice with the given message", () => {
            const message = "Test notification";
            service.show(message);

            expect(Notice).toHaveBeenCalledTimes(1);
            expect(Notice).toHaveBeenCalledWith(message);
        });

        it("should handle empty string message", () => {
            service.show("");

            expect(Notice).toHaveBeenCalledTimes(1);
            expect(Notice).toHaveBeenCalledWith("");
        });

        it("should handle message with special characters", () => {
            const message = "Special: !@#$%^&*()_+-=[]{}|;':\",./<>?";
            service.show(message);

            expect(Notice).toHaveBeenCalledTimes(1);
            expect(Notice).toHaveBeenCalledWith(message);
        });

        it("should handle message with unicode characters", () => {
            const message = "日本語メッセージ 🎉 Émojis ñ";
            service.show(message);

            expect(Notice).toHaveBeenCalledTimes(1);
            expect(Notice).toHaveBeenCalledWith(message);
        });

        it("should handle very long message", () => {
            const message = "a".repeat(1000);
            service.show(message);

            expect(Notice).toHaveBeenCalledTimes(1);
            expect(Notice).toHaveBeenCalledWith(message);
        });

        it("should handle multiline message", () => {
            const message = "Line 1\nLine 2\nLine 3";
            service.show(message);

            expect(Notice).toHaveBeenCalledTimes(1);
            expect(Notice).toHaveBeenCalledWith(message);
        });

        it("should handle multiple consecutive calls", () => {
            service.show("Message 1");
            service.show("Message 2");
            service.show("Message 3");

            expect(Notice).toHaveBeenCalledTimes(3);
            expect(Notice).toHaveBeenNthCalledWith(1, "Message 1");
            expect(Notice).toHaveBeenNthCalledWith(2, "Message 2");
            expect(Notice).toHaveBeenNthCalledWith(3, "Message 3");
        });

        it("should silently handle when Notice constructor throws", () => {
            // Mock the Notice to throw an error
            vi.mocked(Notice).mockImplementationOnce(() => {
                throw new Error("Notice failed");
            });

            // Should not throw
            expect(() => service.show("test")).not.toThrow();
        });

        it("should continue working after a failed notice", () => {
            // First call fails
            vi.mocked(Notice).mockImplementationOnce(() => {
                throw new Error("Notice failed");
            });

            service.show("first"); // Should not throw
            service.show("second"); // Should work normally

            expect(Notice).toHaveBeenCalledTimes(2);
            expect(Notice).toHaveBeenNthCalledWith(1, "first");
            expect(Notice).toHaveBeenNthCalledWith(2, "second");
        });
    });

    describe("INotificationService interface", () => {
        it("should implement INotificationService", () => {
            const instance: INotificationService = new ObsidianNotificationService();
            expect(instance.show).toBeDefined();
            expect(typeof instance.show).toBe("function");
        });

        it("should accept INotificationService type", () => {
            const service: INotificationService = new ObsidianNotificationService();
            expect(service).toBeInstanceOf(ObsidianNotificationService);
        });
    });
});
