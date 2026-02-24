/**
 * @file YAMLベース同期シナリオ自動テスト
 *
 * @description
 * scenarios/ ディレクトリからYAMLファイルを自動検出し、ScenarioRunnerで実行する。
 * 各YAMLファイルは複数端末の同期操作をステップ形式で定義し、基本動作(N1-N5)・
 * 競合検知(C1-C7)・割り込み(I1-I5)・複数端末トポロジー(M1-M4)を網羅する。
 *
 * @prerequisites
 * - scenarios/ 配下にYAMLシナリオファイル
 * - ScenarioRunner (helpers/scenario-runner)
 *
 * @pass_criteria
 * - 各ステップのインデックス状態・ファイル内容・通知が期待値と一致すること
 */

import { describe, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { ScenarioRunner, Scenario } from "../../helpers/scenario-runner";

const SCENARIOS_DIR = join(__dirname, "scenarios");

/** YAMLシナリオの自動検出・実行 — 各ファイルをScenarioRunnerでステップ実行 */
describe("YAML Scenario Tests", () => {
    const files = readdirSync(SCENARIOS_DIR).filter(
        (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
    );

    for (const file of files) {
        const filePath = join(SCENARIOS_DIR, file);
        const scenario = yaml.load(readFileSync(filePath, "utf8")) as Scenario;

        it(scenario.name || file, async () => {
            const runner = new ScenarioRunner(scenario);
            await runner.run();
        });
    }
});
