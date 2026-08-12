import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import {
    actorsCases,
    appsCases,
    paymentsCases,
    registerCases,
    registrationCases,
    storageCases,
    tasksCases,
    toolsCases,
} from '../test_kit/index.js';
import type { SuiteClientOptions } from '../test_kit/index.js';
import type { CaseCtx, SuiteClient, Transport } from '../test_kit/types.js';

export type IntegrationTestsSuiteOptions = {
    suiteName: string;
    transport: Transport;
    createClientFn: (options?: SuiteClientOptions) => Promise<SuiteClient>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
};

/** Register all capability cases for one transport dimension. */
export function createIntegrationTestsSuite(options: IntegrationTestsSuiteOptions) {
    const { suiteName, createClientFn, beforeAllFn, afterAllFn, beforeEachFn, afterEachFn } = options;

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
                createApifyClient: () =>
                    new ApifyClient({
                        token: process.env.APIFY_TOKEN as string,
                        baseUrl: process.env.APIFY_API_BASE_URL,
                    }),
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
