import { describe, it } from 'vitest';

import type { Case, CaseCtx, Fixture } from './types.js';

/**
 * Register cases under `describe(suiteName)`.
 * - `isDeploymentTestOnly`: non-deployment-test → `it.skip`
 * - `skipIf`: also → `it.skip`
 * - `getFixture`: memoized once per call by `fixture.key`
 */
export function registerCases(suiteName: string, cases: Case[], ctx: Omit<CaseCtx, 'getFixture'>): void {
    // eslint-disable-next-line vitest/valid-title -- suiteName is the caller's title string
    describe(suiteName, () => {
        const fixtureCache = new Map<string, Promise<unknown>>();
        const fullCtx: CaseCtx = {
            ...ctx,
            getFixture: async <T>(fixture: Fixture<T>): Promise<T> => {
                let cached = fixtureCache.get(fixture.key) as Promise<T> | undefined;
                if (!cached) {
                    cached = fixture.setup(fullCtx);
                    fixtureCache.set(fixture.key, cached);
                }
                return cached;
            },
        };

        for (const c of cases) {
            const skip = (ctx.isDeploymentTestOnly && !c.isDeploymentTest) || (c.skipIf?.(fullCtx) ?? false);
            const runIt = skip ? it.skip : it;
            const runFn = async () => c.run(fullCtx);
            if (c.retry !== undefined) {
                // eslint-disable-next-line vitest/valid-title vitest/expect-expect
                runIt(c.name, { retry: c.retry }, runFn);
            } else {
                // eslint-disable-next-line vitest/valid-title vitest/expect-expect
                runIt(c.name, runFn);
            }
        }
    });
}
