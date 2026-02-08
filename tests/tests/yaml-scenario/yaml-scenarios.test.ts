import { describe, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { ScenarioRunner, Scenario } from "../../helpers/scenario-runner";

const SCENARIOS_DIR = join(__dirname, "scenarios");

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
