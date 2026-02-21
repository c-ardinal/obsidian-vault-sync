export type { IMergeStrategy, MergeParams } from "./merge-strategy";
export { SmartMergeStrategy } from "./smart-merge";
export { ForceLocalStrategy } from "./force-local";
export { ForceRemoteStrategy } from "./force-remote";
export { AlwaysForkStrategy } from "./always-fork";

import type { IMergeStrategy } from "./merge-strategy";
import { SmartMergeStrategy } from "./smart-merge";
import { ForceLocalStrategy } from "./force-local";
import { ForceRemoteStrategy } from "./force-remote";
import { AlwaysForkStrategy } from "./always-fork";

const strategies: Record<string, IMergeStrategy> = {
    "smart-merge": new SmartMergeStrategy(),
    "force-local": new ForceLocalStrategy(),
    "force-remote": new ForceRemoteStrategy(),
    "always-fork": new AlwaysForkStrategy(),
};

export function getMergeStrategy(name: string): IMergeStrategy {
    return strategies[name] || strategies["smart-merge"];
}
