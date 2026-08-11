import type { Client as ClientV2 } from '@modelcontextprotocol/client';
import type { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';

import type { SuiteClientOptions } from './mcp_client.js';

/** v1 or v2 MCP SDK client. */
export type SuiteClient = ClientV1 | ClientV2;

/**
 * Suite transport dimension.
 * - `2025-11-25`: v1 SDK, streamable HTTP (or stdio in this repo only)
 * - `2026-07-28`: v2 SDK, stateless HTTP, no tasks
 * - `stdio`: this repo only
 */
export type Transport = '2025-11-25' | 'stdio' | '2026-07-28';

export interface CaseCtx {
    createClientFn: (options?: SuiteClientOptions) => Promise<SuiteClient>;
    transport: Transport;
    /** False on 2026-07-28 (no tasks capability). */
    hasTasksSupport: boolean;
    /** Register only `critical: true` cases. */
    criticalOnly?: boolean;
    /** Memoized fixture setup — once per `registerCases` call, keyed by `fixture.key`. */
    getFixture: <T>(fixture: Fixture<T>) => Promise<T>;
}

/** Value shared across cases via `ctx.getFixture`. */
export interface Fixture<T> {
    /** Unique key within the cases array using this fixture. */
    key: string;
    setup: (ctx: CaseCtx) => Promise<T>;
}

/** One integration case. `critical: true` runs in apify-mcp-server-internal too. */
export interface Case {
    name: string;
    /** Deploy-health case for internal's live staging/prod. */
    critical: boolean;
    /** Register as `it.skip` when true. */
    skipIf?: (ctx: CaseCtx) => boolean;
    /** Forwarded to vitest `it(name, { retry }, ...)`. */
    retry?: number;
    run: (ctx: CaseCtx) => Promise<void>;
}
