/**
 * `./test-kit` export. Internal imports shared cases and runs `critical: true` against
 * its live deploy. `vitest` is an optional peer — only `./test-kit` consumers need it.
 */
export { createMcpStatelessClient, createMcpStreamableClient } from './mcp_client.js';
export type { SuiteClientOptions } from './mcp_client.js';
export { registerCases } from './register.js';
export type { Case, CaseCtx, Fixture, SuiteClient, Transport } from './types.js';
export { withClient } from './helpers.js';

export { actorsCases } from './cases/actors.cases.js';
export { appsCases } from './cases/apps.cases.js';
export { paymentsCases } from './cases/payments.cases.js';
export { registrationCases } from './cases/registration.cases.js';
export { storageCases } from './cases/storage.cases.js';
export { tasksCases } from './cases/tasks.cases.js';
export { toolsCases } from './cases/tools.cases.js';

import { actorsCases } from './cases/actors.cases.js';
import { appsCases } from './cases/apps.cases.js';
import { paymentsCases } from './cases/payments.cases.js';
import { registrationCases } from './cases/registration.cases.js';
import { storageCases } from './cases/storage.cases.js';
import { tasksCases } from './cases/tasks.cases.js';
import { toolsCases } from './cases/tools.cases.js';
import type { Case } from './types.js';

/** All cases from every capability group. */
export const allCases: Case[] = [
    ...registrationCases,
    ...toolsCases,
    ...actorsCases,
    ...appsCases,
    ...tasksCases,
    ...storageCases,
    ...paymentsCases,
];
