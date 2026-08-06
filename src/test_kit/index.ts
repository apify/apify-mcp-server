/**
 * Published behind the package's `./test-kit` export subpath (see package.json). Lets
 * `apify-mcp-server-internal` import this repo's own integration cases and run the
 * `critical: true` subset against its own live deploy, instead of hand-duplicating them.
 * `vitest` is an optional peerDependency of this package — only consumers that import
 * `./test-kit` need it installed.
 *
 * Marking a case critical is a one-line edit on its definition in `./cases/*.cases.ts` — there
 * is no second array to keep in sync. Internal calls `registerCases(name, allCases, {
 * ...ctx, criticalOnly: true })` and picks up every current and future critical case automatically.
 */
export { createMcpStatelessClient, createMcpStreamableClient } from './mcp_client.js';
export type { SuiteClientOptions } from './mcp_client.js';
export { registerCases } from './register.js';
export type { Case, CaseCtx, Fixture, SuiteClient, Transport } from './types.js';

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

/** Every case across every group — the convenience import for "give me everything". */
export const allCases: Case[] = [
    ...registrationCases,
    ...toolsCases,
    ...actorsCases,
    ...appsCases,
    ...tasksCases,
    ...storageCases,
    ...paymentsCases,
];
