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
    /**
     * Resolves a shared `Fixture` — `fixture.setup(ctx)` runs at most once per `registerCases`
     * call (i.e. once per transport dimension), memoized by `fixture.key`; every case that asks
     * for the same fixture awaits the same in-flight/resolved promise. Lets several cases share
     * one expensive setup (e.g. one seeded Actor run) without a vitest `beforeAll` — which can't
     * express "shared by only some cases in this array" — and without paying for the setup once
     * per case. See `register.ts`.
     */
    getFixture: <T>(fixture: Fixture<T>) => Promise<T>;
    /**
     * The real Apify API token this run authenticates with — for cases that poll the raw Apify
     * REST API directly (via `ApifyClient`) instead of through an MCP connection, independent of
     * whatever token `createClientFn` used for any one client. Each caller wires this to whatever
     * its own token source is (this repo's own suite: `process.env.APIFY_TOKEN`; internal:
     * whatever its own test-user token helper resolves) — not read from a global env var directly,
     * so it works the same regardless of which repo registers the case.
     */
    getApifyToken: () => string;
}

/** A value computed once and shared across whichever cases ask for it via `ctx.getFixture`. */
export interface Fixture<T> {
    /** Unique across the cases array it's used in — same key resolves to the same memoized value. */
    key: string;
    setup: (ctx: CaseCtx) => Promise<T>;
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
