import { describe, it } from 'vitest';

import type { Scenario, ScenarioCtx } from './types.js';

/**
 * Registers `scenarios` under one `describe(suiteName)` block. When `ctx.criticalOnly` is true
 * (internal running a shared subset against its live deploy), non-critical scenarios register via
 * `it.skip` — a native vitest primitive — so they show up as skipped in reporter output instead of
 * silently vanishing from the test count.
 */
export function registerScenarios(suiteName: string, scenarios: Scenario[], ctx: ScenarioCtx): void {
    // eslint-disable-next-line vitest/valid-title -- suiteName is the caller's title string
    describe(suiteName, () => {
        for (const scenario of scenarios) {
            const runIt = ctx.criticalOnly && !scenario.critical ? it.skip : it;
            // eslint-disable-next-line vitest/valid-title vitest/expect-expect
            runIt(scenario.name, async () => scenario.run(ctx));
        }
    });
}
