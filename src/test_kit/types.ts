import type { Client as ClientV2 } from '@modelcontextprotocol/client';
import type { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';

import type { SuiteClientOptions } from './mcp_client.js';

/**
 * MCP SDK client generation a case is run against — the same v1/v2 client classes
 * `apify-mcp-server-internal` already builds its own authenticated clients from.
 */
export type SuiteClient = ClientV1 | ClientV2;

/**
 * Transport dimension a case is registered under. `2025-11-25` is the legacy spec (v1 SDK,
 * streamable-HTTP or stdio transport); `2026-07-28` is the modern spec (v2 SDK, stateless HTTP,
 * no `tasks` capability). `stdio` only exists in this repo's own suite — internal never runs it.
 */
export type Transport = '2025-11-25' | 'stdio' | '2026-07-28';

export interface CaseCtx {
    createClientFn: (options?: SuiteClientOptions) => Promise<SuiteClient>;
    transport: Transport;
    /** The 2026-07-28 stateless adapter declares no `tasks` capability — false there. */
    hasTasksSupport: boolean;
    /** true when the caller only wants `critical: true` cases registered. */
    criticalOnly?: boolean;
}

/**
 * One integration test case. Defined once, here (or in `./cases/*.cases.ts`), and consumed by
 * both this repo's own suite (`registerCases` with every case) and `apify-mcp-server-internal`
 * (`registerCases` with `criticalOnly: true`) — marking a case `critical: true` is the only edit
 * needed to share it; there is no second array to keep in sync.
 */
export interface Case {
    name: string;
    /** Deploy-health relevant: internal registers these against its own live staging/prod deploy. */
    critical: boolean;
    /** When true, the case registers as `it.skip` instead of running (e.g. unsupported transport). */
    skipIf?: (ctx: CaseCtx) => boolean;
    /** Forwarded to vitest's `it(name, { retry }, ...)` — for cases with known infra flakiness. */
    retry?: number;
    run: (ctx: CaseCtx) => Promise<void>;
}
