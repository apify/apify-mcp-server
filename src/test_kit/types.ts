import type { Client as ClientV2 } from '@modelcontextprotocol/client';
import type { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * MCP SDK client generation a shared critical scenario is run against — the same v1/v2 client
 * classes `apify-mcp-server-internal` already builds its own authenticated clients from.
 */
export type SuiteClient = ClientV1 | ClientV2;

/**
 * Canonical, minimal option surface shared critical scenarios call `createClientFn` with. Each
 * repo's own `createClientFn` wrapper adapts this into its native, larger option type (public's
 * `McpClientOptions`, internal's `MCPClientOptions`) — keeps the shared contract small instead of
 * forcing either repo to rename its own fields to match the other.
 */
export interface ScenarioClientOptions {
    actors?: string[];
    tools?: string[];
    serverMode?: string;
}

export interface ScenarioCtx {
    createClientFn: (options?: ScenarioClientOptions) => Promise<SuiteClient>;
    /** true when the caller only wants `critical: true` scenarios registered. */
    criticalOnly?: boolean;
}

export interface Scenario {
    name: string;
    /** Deploy-health relevant: internal registers these against its own live staging/prod deploy. */
    critical: boolean;
    run: (ctx: ScenarioCtx) => Promise<void>;
}
