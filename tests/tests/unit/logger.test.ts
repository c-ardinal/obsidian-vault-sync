import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncLogger } from "../../../src/sync-manager/logger";

describe("SyncLogger", () => {
    let onWrite: any;
    let logger: SyncLogger;

    beforeEach(() => {
        onWrite = vi.fn().mockResolvedValue(undefined);
        logger = new SyncLogger({
            onWrite,
            enableLogging: true,
            isDeveloperMode: false,
        });
    });

    it("should buffer info logs during a cycle and NOT flush if no action taken", async () => {
        logger.startCycle("timer-sync");
        await logger.info("test message");
        await logger.endCycle();

        expect(onWrite).not.toHaveBeenCalled();
    });

    it("should flush buffered logs if actionTaken is marked", async () => {
        logger.startCycle("timer-sync");
        await logger.info("buffered message");
        logger.markActionTaken();
        await logger.endCycle();

        expect(onWrite).toHaveBeenCalled();
        expect(onWrite.mock.calls[0][0]).toContain("[INFO] buffered message");
    });

    it("should buffer system/error/warn logs during cycle in non-dev mode and flush at the end", async () => {
        logger.startCycle("timer-sync");
        await logger.system("system message");
        expect(onWrite).not.toHaveBeenCalled(); // Now buffered

        await logger.endCycle();
        // Flushed because system level sets criticalLogged=true
        expect(onWrite).toHaveBeenCalledTimes(1);
        expect(onWrite.mock.calls[0][0]).toContain("[SYSTEM] system message");
    });

    it("should flush immediately in Developer Mode even during cycle", async () => {
        logger.setOptions({ isDeveloperMode: true });
        logger.startCycle("timer-sync");
        await logger.info("dev message");
        expect(onWrite).toHaveBeenCalledTimes(1);
        expect(onWrite.mock.calls[0][0]).toContain("[INFO] dev message");
        await logger.endCycle();
    });

    it("should flush everything if isDeveloperMode is true (cycle end)", async () => {
        // This test is redundant now that we flush immediately,
        // but let's ensure endCycle doesn't fail.
        logger.setOptions({ isDeveloperMode: true });
        logger.startCycle("timer-sync");
        await logger.info("dev message");
        await logger.endCycle();
        expect(onWrite).toHaveBeenCalled();
    });

    it("should buffer for always-flush triggers (manual-sync) and flush at the end", async () => {
        logger.startCycle("manual-sync");
        await logger.info("manual message");
        expect(onWrite).not.toHaveBeenCalled(); // Should be buffered

        await logger.endCycle();
        expect(onWrite).toHaveBeenCalled();
        expect(onWrite.mock.calls[0][0]).toContain("[INFO] manual message");
    });

    it("should discard debug logs in manual-sync if NO error/dev", async () => {
        logger.startCycle("manual-sync");
        await logger.info("manual info");
        await logger.debug("manual debug");
        await logger.endCycle();

        expect(onWrite).toHaveBeenCalledTimes(1);
        expect(onWrite.mock.calls[0][0]).toContain("[INFO] manual info");
        expect(onWrite.mock.calls[0][0]).not.toContain("[DEBUG] manual debug");
    });

    it("should NOT discard debug logs if errorOccurred is true", async () => {
        logger.startCycle("timer-sync");
        await logger.info("info log");
        await logger.debug("debug context");
        await logger.error("something failed"); // Error is immediate

        await logger.endCycle(); // Should flush buffer (info + debug)
        expect(onWrite).toHaveBeenCalledTimes(3);
        // 1: Error (immediate), 2: Info (buffered), 3: Debug (buffered)
        const allLogs = onWrite.mock.calls.map((c: any) => c[0]).join("");
        expect(allLogs).toContain("[INFO] info log");
        expect(allLogs).toContain("[DEBUG] debug context");
    });

    it("should still write Critical logs (System/Error/Warn/Notice) if enableLogging is false", async () => {
        logger.setOptions({ enableLogging: false, isDeveloperMode: false });

        await logger.system("critical system info");
        await logger.error("fatal error");
        await logger.warn("important warning");
        await logger.notice("user notification");
        await logger.info("info (should be blocked)");
        await logger.debug("debug (should be blocked)");

        // System/Error/Warn/Notice should be written (4 logs)
        expect(onWrite).toHaveBeenCalledTimes(4);
        const allLogs = onWrite.mock.calls.map((c: any) => c[0]).join("");
        expect(allLogs).toContain("[SYSTEM] critical system info");
        expect(allLogs).toContain("[ERROR] fatal error");
        expect(allLogs).toContain("[WARN] important warning");
        expect(allLogs).toContain("[NOTICE] user notification");
        expect(allLogs).not.toContain("[INFO]");
        expect(allLogs).not.toContain("[DEBUG]");
    });

    it("should write EVERYTHING if isDeveloperMode is true, even if enableLogging is false", async () => {
        logger.setOptions({ enableLogging: false, isDeveloperMode: true });

        await logger.info("dev info");
        await logger.debug("dev debug");
        await logger.warn("dev warn");

        expect(onWrite).toHaveBeenCalledTimes(3);
        const allLogs = onWrite.mock.calls.map((c: any) => c[0]).join("");
        expect(allLogs).toContain("[INFO] dev info");
        expect(allLogs).toContain("[DEBUG] dev debug");
        expect(allLogs).toContain("[WARN] dev warn");
    });

    it("should NOT write normal logs if enableLogging is false", async () => {
        logger.setOptions({ enableLogging: false });
        logger.startCycle("manual-sync");
        await logger.info("wont be written");
        await logger.endCycle();

        expect(onWrite).not.toHaveBeenCalled();
    });

    it("should flush everything at the end if errorOccurred is true", async () => {
        logger.startCycle("timer-sync");
        await logger.info("info before error");
        await logger.error("oops");
        expect(onWrite).not.toHaveBeenCalled(); // Now buffered

        await logger.endCycle();
        // endCycle should flush the buffer because errorOccurred is true (set by error())
        expect(onWrite).toHaveBeenCalledTimes(2);
        const allLogs = onWrite.mock.calls.map((c: any) => c[0]).join("");
        expect(allLogs).toContain("[INFO] info before error");
        expect(allLogs).toContain("[ERROR] oops");
    });
});
