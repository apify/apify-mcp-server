import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'vitest';

import type { McpClientOptions, McpSuiteClient } from '../helpers.js';
import { registerActorsCases } from './cases/actors.cases.js';
import { registerAppsCases } from './cases/apps.cases.js';
import { registerPaymentsCases } from './cases/payments.cases.js';
import { registerRegistrationCases } from './cases/registration.cases.js';
import { createItc, type CreateClientFn } from './cases/shared.js';
import { registerStorageCases } from './cases/storage.cases.js';
import { registerTasksCases } from './cases/tasks.cases.js';
import { registerToolsCases } from './cases/tools.cases.js';

export type IntegrationTestsSuiteOptions = {
    suiteName: string;
    transport: 'streamable-http' | 'stdio' | '2026-07-28';
    createClientFn: (options?: McpClientOptions) => Promise<McpSuiteClient>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
};

/**
 * One suite, three transport dimensions (stdio / streamable-http / 2026-07-28 stateless) — each
 * `actor.server_*.test.ts` / `stdio.test.ts` entry point calls this with its own `createClientFn`.
 * Cases live in `tests/integration/cases/*.cases.ts`, grouped by capability, each exporting a
 * plain `register*Cases(ctx)` that registers its `it`/`describe` blocks directly into this
 * `describe(suiteName, ...)` — same flat structure and test names as before the split, just not
 * all typed into one 3000+-line file. `tests/integration/cases/shared.ts` holds the assertion
 * helpers and the `itc` (create client → run → always close) contract multiple groups share.
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
            const ctx = {
                itc: createItc(createClientFn as CreateClientFn),
                createClientFn: createClientFn as CreateClientFn,
                transport: options.transport,
                hasTasksSupport,
            };

            registerRegistrationCases(ctx);
            registerToolsCases(ctx);
            registerActorsCases(ctx);
            registerAppsCases(ctx);
            registerTasksCases(ctx);
            registerStorageCases(ctx);
            registerPaymentsCases(ctx);
        },
    );
}
