import { expect } from 'vitest';

import { defaults, HELPER_TOOLS, MAX_LIMIT_WITH_INPUT_SCHEMA } from '../../../src/const.js';
import type { Scenario } from '../../../src/test_kit/index.js';
import { ACTOR_NORMAL_MODE, DEFAULT_ACTOR_NAMES } from '../../const.js';
import {
    AUTO_INJECTED_TOOL_NAMES,
    expectToolNamesToContain,
    getToolNames,
    RETIRED_SELECTORS,
    servedDefaultTools,
    servedDefaultToolNames,
} from './shared.js';

/**
 * The subset of registration/actors cases worth sharing with `apify-mcp-server-internal` via
 * `@apify/actors-mcp-server/test-kit` (see `src/test_kit/`). `critical: true` scenarios are
 * deploy-health relevant — internal runs those against its own live staging/prod deploy instead
 * of hand-duplicating the assertions. Registered locally (both critical and non-critical) by
 * `registerRegistrationCases`/`registerActorsCases` via `registerScenarios(..., { criticalOnly:
 * false })` — this file is the single source, not a second copy of an existing itc() case.
 */
export const registrationCriticalScenarios: Scenario[] = [
    {
        name: 'should list all default tools and Actors',
        critical: true,
        run: async (ctx) => {
            const client = await ctx.createClientFn();
            try {
                const tools = await client.listTools();
                expect(tools.tools.length).toEqual(servedDefaultTools().length + defaults.actors.length + 4);

                const names = getToolNames(tools);
                expectToolNamesToContain(names, servedDefaultToolNames());
                expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
                // get-actor-run + storage/abort helpers are auto-injected alongside call-actor.
                expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
                expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'loads no tools for retired selectors',
        critical: false,
        run: async (ctx) => {
            const client = await ctx.createClientFn({ tools: [...RETIRED_SELECTORS] });
            try {
                const names = getToolNames(await client.listTools());
                expect(names).toHaveLength(0);
            } finally {
                await client.close();
            }
        },
    },
];

export const actorsCriticalScenarios: Scenario[] = [
    {
        name: 'should find Actors in store search',
        critical: true,
        run: async (ctx) => {
            const client = await ctx.createClientFn();
            try {
                const result = await client.callTool({
                    name: HELPER_TOOLS.STORE_SEARCH,
                    arguments: { keywords: 'normal-mode-test-actor', limit: 5 },
                });
                const content = result.content as { text: string }[];
                expect(content.some((item) => item.text.includes(ACTOR_NORMAL_MODE))).toBe(true);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should not return rental Actors from store search',
        critical: false,
        // Upstream-contract canary: apify-core's `AGENT_SAFE_PRICING_MODELS` filter
        // (`GET /v2/store`) is what excludes rental Actors. If that contract ever
        // drifts, this test catches the regression on the MCP side.
        run: async (ctx) => {
            const client = await ctx.createClientFn();
            try {
                const result = await client.callTool({
                    name: HELPER_TOOLS.STORE_SEARCH,
                    arguments: { keywords: 'rental', limit: MAX_LIMIT_WITH_INPUT_SCHEMA },
                });
                const content = result.content as { text: string }[];
                expect(content.length).toBe(1);
                const outputText = content[0].text;
                expect(outputText).toContain('This Actor');
                expect(outputText).not.toContain('This Actor is rental');
            } finally {
                await client.close();
            }
        },
    },
];
