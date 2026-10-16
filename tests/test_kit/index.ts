/**
 * `./test-kit` export. Internal imports shared cases and runs `isDeploymentTest: true` against
 * its live deploy. Consumers install `vitest` themselves. It is not declared as a peer: an optional
 * `vitest` peer crashes `npm install` on npm 10 (`Cannot read properties of null (reading 'edgesOut')`).
 */
export { createMcpStatelessClient, createMcpStreamableClient } from './mcp_client.js';
export type { SuiteClientOptions } from './mcp_client.js';
export { registerCases } from './register.js';
export type { Case, CaseCtx, Fixture, SuiteClient, Transport } from './types.js';
export {
    expectNormalModeTestStructuredContent,
    expectToolNamesToContain,
    expectWidgetToolMeta,
    getToolNames,
    withClient,
} from './helpers.js';

export { actorsCases } from './cases/actors.cases.js';
export { appsCases } from './cases/apps.cases.js';
export { paymentsCases } from './cases/payments.cases.js';
export { registrationCases } from './cases/registration.cases.js';
export { schedulesCases } from './cases/schedules.cases.js';
export { sourceCases } from './cases/source.cases.js';
export { storageCases } from './cases/storage.cases.js';
export { tasksCases } from './cases/tasks.cases.js';
export { toolsCases } from './cases/tools.cases.js';

import { actorsCases } from './cases/actors.cases.js';
import { appsCases } from './cases/apps.cases.js';
import { paymentsCases } from './cases/payments.cases.js';
import { registrationCases } from './cases/registration.cases.js';
import { schedulesCases } from './cases/schedules.cases.js';
import { sourceCases } from './cases/source.cases.js';
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
    ...schedulesCases,
    ...sourceCases,
    ...paymentsCases,
];
