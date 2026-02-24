/**
 * @file 並列実行ユーティリティのユニットテスト
 *
 * @description
 * runParallelの並列度制御、結果収集、エラー伝播を検証する。
 *
 * @pass_criteria
 * - 並列度(concurrency)が指定値を超えないこと
 * - 全タスクの結果が収集されること
 * - 1つのタスクが失敗→Promise全体がrejectすること
 * - concurrency=0 / 空タスク→空配列
 */

import { describe, it, expect } from "vitest";
import { runParallel } from "../../../src/sync-manager/file-utils";

describe("runParallel", () => {
    it("should execute all tasks and return results", async () => {
        const tasks = [
            () => Promise.resolve(1),
            () => Promise.resolve(2),
            () => Promise.resolve(3),
        ];
        const results = await runParallel(tasks, 10);
        expect(results).toHaveLength(3);
        expect(results).toContain(1);
        expect(results).toContain(2);
        expect(results).toContain(3);
    });

    it("should return empty array for empty task list", async () => {
        const results = await runParallel([], 5);
        expect(results).toEqual([]);
    });

    it("should return empty array for zero concurrency", async () => {
        const tasks = [() => Promise.resolve(1)];
        const results = await runParallel(tasks, 0);
        expect(results).toEqual([]);
    });

    it("should respect concurrency limit", async () => {
        let activeTasks = 0;
        let maxActive = 0;
        const concurrency = 2;

        const tasks = Array.from({ length: 6 }, () => async () => {
            activeTasks++;
            maxActive = Math.max(maxActive, activeTasks);
            await new Promise((r) => setTimeout(r, 20));
            activeTasks--;
            return maxActive;
        });

        await runParallel(tasks, concurrency);
        expect(maxActive).toBeLessThanOrEqual(concurrency);
    });

    it("should handle concurrency greater than task count", async () => {
        const tasks = [
            () => Promise.resolve("a"),
            () => Promise.resolve("b"),
        ];
        const results = await runParallel(tasks, 100);
        expect(results).toHaveLength(2);
    });

    it("should propagate errors from tasks", async () => {
        const tasks = [
            () => Promise.resolve(1),
            () => Promise.reject(new Error("task failed")),
        ];
        await expect(runParallel(tasks, 2)).rejects.toThrow("task failed");
    });

    it("should handle single task with concurrency 1", async () => {
        const tasks = [() => Promise.resolve(42)];
        const results = await runParallel(tasks, 1);
        expect(results).toEqual([42]);
    });

    it("should execute tasks sequentially with concurrency 1", async () => {
        const order: number[] = [];
        const tasks = [1, 2, 3].map((n) => async () => {
            order.push(n);
            await new Promise((r) => setTimeout(r, 5));
            return n;
        });

        await runParallel(tasks, 1);
        expect(order).toEqual([1, 2, 3]);
    });
});
