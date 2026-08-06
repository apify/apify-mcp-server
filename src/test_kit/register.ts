import { describe, it } from 'vitest';

import type { Case, CaseCtx, Fixture } from './types.js';

/**
 * Registers `cases` under one `describe(suiteName)` block. When `ctx.criticalOnly` is true
 * (internal running the shared subset against its live deploy), non-critical cases register via
 * `it.skip` — a native vitest primitive — so they show up as skipped in reporter output instead of
 * silently vanishing from the test count. A case's own `skipIf` (e.g. unsupported transport) is
 * honored the same way, independent of `criticalOnly`.
 *
 * `ctx.getFixture` is wired here, not by the caller — one fixture cache per `registerCases` call,
 * so a fixture's `setup` runs at most once per transport dimension no matter how many cases in
 * this array ask for it (concurrently or not: the cache stores the in-flight promise itself, so
 * a second `getFixture` call for the same key while `setup` is still running awaits that same
 * promise instead of starting a second run).
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
            const skip = (ctx.criticalOnly && !c.critical) || (c.skipIf?.(fullCtx) ?? false);
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
