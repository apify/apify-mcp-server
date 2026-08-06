import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'vitest';

import {
    actorsCases,
    appsCases,
    paymentsCases,
    registerCases,
    registrationCases,
    storageCases,
    tasksCases,
    toolsCases,
} from '../../src/test_kit/index.js';
import type { CaseCtx, Transport } from '../../src/test_kit/types.js';
import type { McpClientOptions, McpSuiteClient } from '../helpers.js';

export type IntegrationTestsSuiteOptions = {
    suiteName: string;
    transport: Transport;
    createClientFn: (options?: McpClientOptions) => Promise<McpSuiteClient>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
};

/**
 * One suite, three transport dimensions (stdio / 2025-11-25 streamable-HTTP / 2026-07-28
 * stateless) — each `actor.server_*.test.ts` / `stdio.test.ts` entry point calls this with its
 * own `createClientFn`. Every group's cases live in `src/test_kit/cases/*.cases.ts` (published
 * behind `./test-kit` so `apify-mcp-server-internal` can import the exact same definitions);
 * `registerCases` here registers all of them (critical and non-critical) for this repo's own CI
 * run. Cases that share expensive setup (e.g. one seeded Actor run) do so via `ctx.getFixture`
 * (see `src/test_kit/types.ts`), not a vitest `beforeAll` — that lets the setup stay scoped to
 * only the cases that need it while still running once per dimension, not once per case.
 */
export function createIntegrationTestsSuite(options: IntegrationTestsSuiteOptions) {
    const { suiteName, createClientFn, beforeAllFn, afterAllFn, beforeEachFn, afterEachFn } = options;

    // The 2026-07-28 stateless adapter declares no `tasks` capability, so `tasks/*` is
    // method-not-found there — the Tasks cases run on the legacy dimensions only.
    const hasTasksSupport = options.transport !== '2026-07-28';

    if (beforeAllFn) beforeAll(beforeAllFn);
    if (afterAllFn) afterAll(afterAllFn);
    if (beforeEachFn) beforeEach(beforeEachFn);
    if (afterEachFn) afterEach(afterEachFn);

    describe(
        // eslint-disable-next-line vitest/valid-title -- parametric suite factory; title is the suiteName argument
        suiteName,
        {
            concurrent: true, // Every test declares and closes its own client — safe to parallelize.
        },
        () => {
            const ctx: Omit<CaseCtx, 'getFixture'> = {
                createClientFn: createClientFn as CaseCtx['createClientFn'],
                transport: options.transport,
                hasTasksSupport,
                getApifyToken: () => process.env.APIFY_TOKEN as string,
            };

            registerCases('registration', registrationCases, ctx);
            registerCases('tools', toolsCases, ctx);
            registerCases('actors', actorsCases, ctx);
            registerCases('apps', appsCases, ctx);
            registerCases('tasks', tasksCases, ctx);
            registerCases('storage', storageCases, ctx);
            registerCases('payments', paymentsCases, ctx);
        },
    );
}
