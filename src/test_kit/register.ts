import { describe, it } from 'vitest';

import type { Case, CaseCtx } from './types.js';

/**
 * Registers `cases` under one `describe(suiteName)` block. When `ctx.criticalOnly` is true
 * (internal running the shared subset against its live deploy), non-critical cases register via
 * `it.skip` — a native vitest primitive — so they show up as skipped in reporter output instead of
 * silently vanishing from the test count. A case's own `skipIf` (e.g. unsupported transport) is
 * honored the same way, independent of `criticalOnly`.
 */
export function registerCases(suiteName: string, cases: Case[], ctx: CaseCtx): void {
    // eslint-disable-next-line vitest/valid-title -- suiteName is the caller's title string
    describe(suiteName, () => {
        for (const c of cases) {
            const skip = (ctx.criticalOnly && !c.critical) || (c.skipIf?.(ctx) ?? false);
            const runIt = skip ? it.skip : it;
            const runFn = async () => c.run(ctx);
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
