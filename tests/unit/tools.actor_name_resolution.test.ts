/**
 * A bare Actor name in call-actor and fetch-actor-details, against the REAL `actorDefinitionCache` and its
 * ownership gate. A name alone means the caller's own Actor (`~name`), so it must never key the process-wide
 * cache: `tests/unit/tools.schedule_actor_resolution.test.ts` covers the cross-tenant bug that caused before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tools/actors/actor_definition.js', () => ({ getActorDefinition: vi.fn() }));

vi.mock('../../src/utils/actor_details.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/utils/actor_details.js');
    return { ...actual, fetchActorDetails: vi.fn() };
});

vi.mock('../../src/mcp/client.js', () => ({
    connectMCPClient: vi.fn(async () => ({
        listTools: async () => ({
            tools: [{ name: 'add', description: 'adds', inputSchema: { type: 'object', properties: {} } }],
        }),
        callTool: async () => ({ content: [{ type: 'text', text: 'MCP result' }] }),
        close: async () => {},
    })),
}));

import { HELPER_TOOLS } from '../../src/const.js';
import type { PaymentProvider } from '../../src/payments/types.js';
import { actorDefinitionCache } from '../../src/state.js';
import { getActorDefinition } from '../../src/tools/actors/actor_definition.js';
import {
    callActorPreExecute,
    checkPaymentProviderStandbyConflict,
    executeCallActor,
} from '../../src/tools/actors/call_actor.js';
import { buildFetchActorDetailsResult } from '../../src/tools/actors/fetch_actor_details.js';
import type { ActorDefinitionWithInfo, ActorStore, InternalToolArgs } from '../../src/types.js';
import type { ActorDetailsResult } from '../../src/utils/actor_details.js';
import { fetchActorDetails } from '../../src/utils/actor_details.js';
import type { ToolResponse } from '../../src/utils/mcp.js';
import { mockApifyClient, stubToolCallContext, textOf } from './helpers/tool_context.js';

const getActorDefinitionMock = vi.mocked(getActorDefinition);
const fetchActorDetailsMock = vi.mocked(fetchActorDetails);

const PAYMENT_PROVIDER = { id: 'x402' } as unknown as PaymentProvider;
const OWN_ACTORS_FACT = 'A name without a username is looked up among your own Actors only';

/** Definitions by the key `getActorDefinition` is called with; anything else is unknown. */
const definitionsByKey = new Map<string, ActorDefinitionWithInfo>();
/** Details by the key `fetchActorDetails` is called with; anything else is unknown. */
const detailsByKey = new Map<string, ActorDetailsResult>();

/** The cache is process-wide and outlives each test, so every test uses names of its own. */
function uniqueName(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A bare value shaped like an ID: 17 alphanumeric characters. */
function uniqueIdShapedName(): string {
    return `own${Math.random().toString(36).slice(2)}`.padEnd(17, '0').slice(0, 17);
}

/**
 * Public, so the cache's ownership gate serves a cached entry to any caller: keyed by a bare name, one tenant's
 * Actor would answer another tenant's lookup.
 */
function defineActor(fullName: string, { isMcpServer = false, keys = [fullName] } = {}): void {
    const [username, name] = fullName.split('/');
    const id = `${username}-${name}`;
    const definition = {
        definition: {
            id,
            actorFullName: fullName,
            input: { type: 'object', properties: { url: { type: 'string', description: 'a url' } } },
            ...(isMcpServer && { webServerMcpPath: '/mcp' }),
        },
        info: {
            id,
            username,
            name,
            isPublic: true,
            userId: username,
            ...(isMcpServer && { actorStandby: { isEnabled: true } }),
        },
    } as unknown as ActorDefinitionWithInfo;
    for (const key of keys) definitionsByKey.set(key, definition);
}

function defineDetails(fullName: string, keys = [fullName]): void {
    const [username, name] = fullName.split('/');
    const details = {
        actorInfo: { id: `${username}-${name}`, username, name },
        actorCard: '',
        actorCardStructured: {},
        inputSchema: { type: 'object', properties: {} },
        readme: '',
    } as unknown as ActorDetailsResult;
    for (const key of keys) detailsByKey.set(key, details);
}

/** A tenant's client: `actor('~name').get()` answers only for the names that tenant owns. */
function tenantClient(username: string, ownNames: string[] = []) {
    const actor = vi.fn((key: string) => ({
        get: async () => {
            const name = key.slice(1);
            return key.startsWith('~') && ownNames.includes(name)
                ? { id: `${username}-${name}`, username, name }
                : undefined;
        },
        start: vi.fn(async () => ({ id: 'RUN_ID', actId: `${username}-${key}`, status: 'READY' })),
    }));
    return { client: mockApifyClient({ token: `token-${username}`, actor }), actor };
}

function toolArgsFor(
    args: Record<string, unknown>,
    client: InternalToolArgs['apifyClient'],
    { paymentProvider, actorStore }: { paymentProvider?: PaymentProvider; actorStore?: ActorStore } = {},
): InternalToolArgs {
    return { ...stubToolCallContext(args, client), paymentProvider, actorStore };
}

function textOfResponse(response: ToolResponse): string {
    return (response.content ?? []).map(textOf).join('\n');
}

function keysPassedTo(mock: { mock: { calls: unknown[][] } }, argIndex = 0): unknown[] {
    return mock.mock.calls.map((call) => call[argIndex]);
}

beforeEach(() => {
    vi.restoreAllMocks();
    definitionsByKey.clear();
    detailsByKey.clear();
    getActorDefinitionMock.mockReset();
    getActorDefinitionMock.mockImplementation(async (key) => definitionsByKey.get(key) ?? null);
    fetchActorDetailsMock.mockReset();
    fetchActorDetailsMock.mockImplementation(async (_client, key) => detailsByKey.get(key) ?? null);
});

describe('callActorPreExecute() Actor resolution', () => {
    function preExecute(
        actor: string,
        client: InternalToolArgs['apifyClient'],
        options: { paymentProvider?: PaymentProvider } = {},
    ) {
        return callActorPreExecute(toolArgsFor({ actor, input: {} }, client, options), {
            route: HELPER_TOOLS.ACTOR_CALL,
        });
    }

    function resolvedNameOf(result: Awaited<ReturnType<typeof preExecute>>): string {
        expect('baseActorName' in result).toBe(true);
        return (result as { baseActorName: string }).baseActorName;
    }

    function earlyResponseOf(result: Awaited<ReturnType<typeof preExecute>>): ToolResponse {
        expect('earlyResponse' in result).toBe(true);
        return (result as { earlyResponse: ToolResponse }).earlyResponse;
    }

    it('resolves the same bare name to each account own Actor', async () => {
        const name = uniqueName('shared');
        defineActor(`tenant-a/${name}`);
        defineActor(`tenant-b/${name}`);

        const first = await preExecute(name, tenantClient('tenant-a', [name]).client);
        const second = await preExecute(name, tenantClient('tenant-b', [name]).client);

        expect(resolvedNameOf(first)).toBe(`tenant-a/${name}`);
        expect(resolvedNameOf(second)).toBe(`tenant-b/${name}`);
    });

    it('never keys the shared definition cache by a name without a username', async () => {
        const name = uniqueName('cached');
        defineActor(`tenant-a/${name}`);
        const { client } = tenantClient('tenant-a', [name]);
        const cacheSet = vi.spyOn(actorDefinitionCache, 'set');

        const bare = await preExecute(name, client);
        const tilde = await preExecute(`~${name}`, client);

        expect(resolvedNameOf(bare)).toBe(`tenant-a/${name}`);
        expect(resolvedNameOf(tilde)).toBe(`tenant-a/${name}`);
        expect(keysPassedTo(cacheSet)).toEqual([`tenant-a/${name}`]);
        expect(actorDefinitionCache.get(`~${name}`)).toBeNull();
        expect(keysPassedTo(getActorDefinitionMock)).toEqual([`tenant-a/${name}`]);
    });

    it('keeps the :toolName suffix when the bare name is an own MCP server Actor', async () => {
        const name = uniqueName('mcp');
        defineActor(`tenant-a/${name}`, { isMcpServer: true });

        const result = await preExecute(`${name}:add`, tenantClient('tenant-a', [name]).client);

        expect(earlyResponseOf(result).structuredContent).toMatchObject({
            actorName: `tenant-a/${name}`,
            summary: `Called MCP tool 'add' on 'tenant-a/${name}'.`,
        });
    });

    it('tries an ID-shaped value as an ID first, then as the caller own name', async () => {
        const name = uniqueIdShapedName();
        defineActor(`tenant-a/${name}`);
        const { client, actor } = tenantClient('tenant-a', [name]);

        const result = await preExecute(name, client);

        expect(resolvedNameOf(result)).toBe(`tenant-a/${name}`);
        expect(keysPassedTo(getActorDefinitionMock)).toEqual([name, `tenant-a/${name}`]);
        expect(keysPassedTo(actor)).toEqual([`~${name}`]);
    });

    it.each([
        ['an ID', () => uniqueIdShapedName()],
        ['a username/name', () => `tenant-a/${uniqueName('full')}`],
        ['a username~name', () => `tenant-a~${uniqueName('tilde')}`],
    ])('looks up %s with no extra request', async (_label, makeKey) => {
        const key = makeKey();
        defineActor(`tenant-a/${uniqueName('target')}`, { keys: [key] });
        const { client, actor } = tenantClient('tenant-a');

        const result = await preExecute(key, client);

        expect(resolvedNameOf(result)).toBe(key);
        expect(actor).not.toHaveBeenCalled();
        expect(keysPassedTo(getActorDefinitionMock)).toEqual([key]);
    });

    it('states that a bare name means the caller own Actors when none matches', async () => {
        const name = uniqueName('missing');

        const result = await preExecute(name, tenantClient('tenant-a').client);

        const text = textOfResponse(earlyResponseOf(result));
        expect(text).toContain(`Actor '${name}' was not found.`);
        expect(text).toContain(OWN_ACTORS_FACT);
        expect(getActorDefinitionMock).not.toHaveBeenCalled();
    });

    // The ~name read finds the Actor, but its definition comes from the default build, which an Actor gets only from
    // its first successful build.
    it('states that the own Actor a bare name found has no successful build when it has no definition', async () => {
        const name = uniqueName('unbuilt');

        const result = await preExecute(name, tenantClient('tenant-a', [name]).client);

        const text = textOfResponse(earlyResponseOf(result));
        expect(text).toBe(`Actor 'tenant-a/${name}' exists in your account but has no successful build yet.`);
        expect(keysPassedTo(getActorDefinitionMock)).toEqual([`tenant-a/${name}`]);
    });

    // There is no account behind a payment provider, so a bare name keeps today's lookup; the standby check in the
    // tool-call engine then reads the same name the call goes on with.
    it('looks a bare name up as given under a payment provider, as the standby check does', async () => {
        const name = uniqueName('paid');
        defineActor(`tenant-a/${name}`);
        const { client, actor } = tenantClient('tenant-a', [name]);

        await checkPaymentProviderStandbyConflict({
            actorName: name,
            paymentProvider: PAYMENT_PROVIDER,
            apifyToken: 'test-token',
        });
        const result = await preExecute(name, client, { paymentProvider: PAYMENT_PROVIDER });

        expect(resolvedNameOf(result)).toBe(name);
        expect(actor).not.toHaveBeenCalled();
        expect(keysPassedTo(getActorDefinitionMock)).toEqual([name, name]);
    });
});

describe('executeCallActor() Actor resolution', () => {
    it('starts the run of the own Actor a bare name resolves to', async () => {
        const name = uniqueName('run');
        defineActor(`tenant-a/${name}`);
        const { client, actor } = tenantClient('tenant-a', [name]);

        const result = await executeCallActor(toolArgsFor({ actor: name, input: {}, waitSecs: 0 }, client));

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ actorName: `tenant-a/${name}` });
        expect(keysPassedTo(actor)).toEqual([`~${name}`, `tenant-a/${name}`]);
    });
});

describe('buildFetchActorDetailsResult() Actor resolution', () => {
    function fetchDetails(
        actor: string,
        client: InternalToolArgs['apifyClient'],
        {
            output = { inputSchema: true },
            ...options
        }: { output?: Record<string, boolean>; paymentProvider?: PaymentProvider; actorStore?: ActorStore } = {},
    ) {
        return buildFetchActorDetailsResult(toolArgsFor({ actor, output }, client, options));
    }

    it('resolves the same bare name to each account own Actor', async () => {
        const name = uniqueName('shared');
        defineDetails(`tenant-a/${name}`);
        defineDetails(`tenant-b/${name}`);

        const first = await fetchDetails(name, tenantClient('tenant-a', [name]).client);
        const second = await fetchDetails(name, tenantClient('tenant-b', [name]).client);

        expect(textOfResponse(first)).toContain(`https://apify.com/tenant-a/${name}/input`);
        expect(textOfResponse(second)).toContain(`https://apify.com/tenant-b/${name}/input`);
        expect(keysPassedTo(fetchActorDetailsMock, 1)).toEqual([`tenant-a/${name}`, `tenant-b/${name}`]);
    });

    it('hands the full name to the MCP tool listing and the output schema store', async () => {
        const name = uniqueName('mcp');
        defineDetails(`tenant-a/${name}`);
        defineActor(`tenant-a/${name}`, { isMcpServer: true });
        const actorStore = {
            getActorOutputSchema: vi.fn(async () => null),
            getActorOutputSchemaAsTypeObject: vi.fn(async () => ({ url: 'string' })),
        };
        const cacheSet = vi.spyOn(actorDefinitionCache, 'set');

        const result = await fetchDetails(name, tenantClient('tenant-a', [name]).client, {
            output: { mcpTools: true, outputSchema: true },
            actorStore,
        });

        expect(textOfResponse(result)).toContain(`To call a tool, use: "tenant-a/${name}:{toolName}"`);
        expect(actorStore.getActorOutputSchemaAsTypeObject).toHaveBeenCalledWith(`tenant-a/${name}`);
        expect(keysPassedTo(cacheSet)).toEqual([`tenant-a/${name}`]);
    });

    it('tries an ID-shaped value as an ID first, then as the caller own name', async () => {
        const name = uniqueIdShapedName();
        defineDetails(`tenant-a/${name}`);
        const { client, actor } = tenantClient('tenant-a', [name]);

        const result = await fetchDetails(name, client);

        expect(result.isError).not.toBe(true);
        expect(keysPassedTo(fetchActorDetailsMock, 1)).toEqual([name, `tenant-a/${name}`]);
        expect(keysPassedTo(actor)).toEqual([`~${name}`]);
    });

    it.each([
        ['an ID', () => uniqueIdShapedName()],
        ['a username/name', () => `tenant-a/${uniqueName('full')}`],
    ])('looks up %s with no extra request', async (_label, makeKey) => {
        const key = makeKey();
        defineDetails(`tenant-a/${uniqueName('target')}`, [key]);
        const { client, actor } = tenantClient('tenant-a');

        const result = await fetchDetails(key, client);

        expect(result.isError).not.toBe(true);
        expect(actor).not.toHaveBeenCalled();
        expect(keysPassedTo(fetchActorDetailsMock, 1)).toEqual([key]);
    });

    it('states that a bare name means the caller own Actors when none matches', async () => {
        const name = uniqueName('missing');

        const result = await fetchDetails(name, tenantClient('tenant-a').client);

        const text = textOfResponse(result);
        expect(text).toContain(`Actor information for '${name}' was not found.`);
        expect(text).toContain(OWN_ACTORS_FACT);
        expect(fetchActorDetailsMock).not.toHaveBeenCalled();
    });

    it('states that the own Actor a bare name found has no successful build when it has no details', async () => {
        const name = uniqueName('unbuilt');

        const result = await fetchDetails(name, tenantClient('tenant-a', [name]).client);

        expect(result.isError).toBe(true);
        expect(textOfResponse(result)).toBe(
            `Actor 'tenant-a/${name}' exists in your account but has no successful build yet.`,
        );
        expect(keysPassedTo(fetchActorDetailsMock, 1)).toEqual([`tenant-a/${name}`]);
    });

    it('looks a bare name up as given under a payment provider', async () => {
        const name = uniqueName('paid');
        const { client, actor } = tenantClient('tenant-a', [name]);

        const result = await fetchDetails(name, client, { paymentProvider: PAYMENT_PROVIDER });

        expect(actor).not.toHaveBeenCalled();
        expect(keysPassedTo(fetchActorDetailsMock, 1)).toEqual([name]);
        expect(textOfResponse(result)).not.toContain(OWN_ACTORS_FACT);
    });
});
