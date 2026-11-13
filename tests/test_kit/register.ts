import { describe, it } from 'vitest';

import type { Case, CaseCtx, Fixture } from './types.js';

/**
 * Retries of a case that sets no `retry`. Cases run against the live platform: about 1 run in 800 of the test Actor
 * hangs on one of its own API calls, so it is still running, or has failed, when the tool's wait ends, and the API
 * can answer 429. A retry starts a fresh run; a case that fails for a real reason fails on the retry too.
 */
const DEFAULT_RETRY = 1;

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
            // eslint-disable-next-line vitest/valid-title vitest/expect-expect
            runIt(c.name, { retry: c.retry ?? DEFAULT_RETRY, timeout: c.timeout }, runFn);
        }
    });
}
