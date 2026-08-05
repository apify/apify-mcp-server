/**
 * Published behind the package's `./test-kit` export subpath (see package.json). Lets
 * `apify-mcp-server-internal` import and run the `critical: true` subset of the shared
 * integration cases (`tests/integration/cases/shared_scenarios.ts`) against its own live
 * deploy, instead of hand-duplicating those assertions. `vitest` is an optional
 * peerDependency of this package — only consumers that import `./test-kit` need it installed.
 */
export { createMcpStatelessClient, createMcpStreamableClient } from './mcp_client.js';
export type { SuiteClientOptions } from './mcp_client.js';
export { registerScenarios } from './register.js';
export type { Scenario, ScenarioClientOptions, ScenarioCtx, SuiteClient } from './types.js';
