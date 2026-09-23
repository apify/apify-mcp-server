import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { updateActor } from '../../src/tools/actors/update_actor.js';
import { updateActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { ALL_TOOLS_PRESENT } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const userGetMock = vi.fn();
const actorGetMock = vi.fn();
const actorUpdateMock = vi.fn();
const actorMock = vi.fn(() => ({ get: actorGetMock, update: actorUpdateMock }));

const stubClient = {
    user: () => ({ get: userGetMock }),
    actor: actorMock,
} as unknown as InternalToolArgs['apifyClient'];

const ACTOR_ID = 'qGXMy0NAkWsIIb9LZ';
const ACTOR_NAME_RULE_TEXT =
    'Actor name must be 3 to 63 characters: letters, digits and dashes, not starting or ending with a dash.';

/** An Actor API document; `userId`, `deploymentKey`, the env var value and the standby tenancy must not leak. */
function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        title: 'My Actor',
        description: 'Scrapes things.',
        seoTitle: 'My Actor for search engines',
        seoDescription: 'Scrapes things, described for search engines.',
        categories: ['AI'],
        isPublic: false,
        isDeprecated: false,
        deploymentKey: 'deploy-secret',
        versions: [{ versionNumber: '0.0', envVars: [{ name: 'TOKEN', value: 'env-secret', isSecret: true }] }],
        stats: { totalRuns: 3 },
        defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 3600, maxItems: 7 },
        actorStandby: {
            isEnabled: false,
            build: 'latest',
            memoryMbytes: 1024,
            idleTimeoutSecs: 300,
            desiredRequestsPerActorRun: 3,
            maxRequestsPerActorRun: 4,
            tenancy: 'SINGLE_TENANT',
            isConsoleAuthEnabled: false,
        },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        modifiedAt: new Date('2026-09-23T10:00:00.000Z'),
        ...overrides,
    };
}

const EXPECTED_RESULT = {
    id: 'actor-1',
    name: 'my-actor',
    username: 'john',
    fullName: 'john/my-actor',
    title: 'My Actor',
    description: 'Scrapes things.',
    seoTitle: 'My Actor for search engines',
    seoDescription: 'Scrapes things, described for search engines.',
    categories: ['AI'],
    isPublic: false,
    isDeprecated: false,
    defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 3600 },
    actorStandby: {
        isEnabled: false,
        build: 'latest',
        memoryMbytes: 1024,
        idleTimeoutSecs: 300,
        desiredRequestsPerActorRun: 3,
        maxRequestsPerActorRun: 4,
    },
    modifiedAt: '2026-09-23T10:00:00.000Z',
};

function apiError(status: number, type: string, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

type UpdateActorToolResult = TextToolResult & { isError?: boolean; toolTelemetry?: ToolTelemetrySnapshot };

const callTool = async (args: Record<string, unknown>) =>
    (await (updateActor as HelperTool).call(
        stubToolCallContext({ actor: 'my-actor', ...args }, stubClient),
    )) as UpdateActorToolResult;

/** Calls the tool expecting a soft-fail result and returns its text. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await callTool(args);
    expectSoftFailInvalidInput(result);
    return result.content[0].text;
};

/** The one payload sent to the update call; compared with `toStrictEqual` so an undefined key fails too. */
const sentPayload = () => {
    expect(actorUpdateMock).toHaveBeenCalledTimes(1);
    return actorUpdateMock.mock.calls[0][0] as Record<string, unknown>;
};

const expectNoApiCall = () => {
    expect(userGetMock).not.toHaveBeenCalled();
    expect(actorGetMock).not.toHaveBeenCalled();
    expect(actorUpdateMock).not.toHaveBeenCalled();
};

describe('update-actor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userGetMock.mockResolvedValue({ username: 'john', id: 'user-secret' });
        actorGetMock.mockResolvedValue(mockActor());
        actorUpdateMock.mockImplementation(async (update: Record<string, unknown>) => mockActor(update));
    });

    it('has the expected tool name and annotations, and no payment requirement', () => {
        expect(updateActor.name).toBe(HELPER_TOOLS.ACTOR_UPDATE);
        expect(updateActor.annotations).toEqual({
            title: 'Update Actor',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect(updateActor.paymentRequired).toBeUndefined();
    });

    it('updates the resolved Actor by its ID with only the given field and returns the stored settings', async () => {
        const { content, structuredContent } = await callTool({ title: 'My Actor' });

        expect(actorMock).toHaveBeenNthCalledWith(1, 'john/my-actor');
        expect(actorMock).toHaveBeenLastCalledWith('actor-1');
        expect(sentPayload()).toStrictEqual({ title: 'My Actor' });
        expect(structuredContent).toEqual(EXPECTED_RESULT);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toBe('Updated john/my-actor: title.');
    });

    it.each([
        ['title', 'New title'],
        ['description', 'New description.'],
        ['seoTitle', 'New SEO title'],
        ['seoDescription', 'New SEO description.'],
        ['categories', ['DEVELOPER_TOOLS', 'MCP_SERVERS']],
        ['isDeprecated', true],
        ['isDeprecated', false],
        ['defaultRunOptions', { build: '0.1.12' }],
        ['actorStandby', { isEnabled: true }],
    ])('sends %s exactly as given and nothing else', async (field, value) => {
        const { content } = await callTool({ [field]: value });

        expect(sentPayload()).toStrictEqual({ [field]: value });
        expect(content[1].text).toBe(`Updated john/my-actor: ${field}.`);
    });

    it('sends every field given in one call and names them in the summary', async () => {
        const fields = {
            name: 'my-actor',
            title: 'New title',
            description: 'New description.',
            seoTitle: 'New SEO title',
            seoDescription: 'New SEO description.',
            categories: ['AI', 'AGENTS', 'OPEN_SOURCE'],
            isDeprecated: true,
            defaultRunOptions: { build: 'beta', memoryMbytes: 4096, timeoutSecs: 0 },
            actorStandby: {
                isEnabled: true,
                build: 'beta',
                memoryMbytes: 2048,
                idleTimeoutSecs: 5,
                desiredRequestsPerActorRun: 1,
                maxRequestsPerActorRun: 10,
            },
        };

        const { content } = await callTool(fields);

        expect(sentPayload()).toStrictEqual(fields);
        expect(content[1].text).toBe(
            'Updated john/my-actor: name, title, description, seoTitle, seoDescription, categories, isDeprecated, defaultRunOptions, actorStandby.',
        );
    });

    it('passes an empty title and description to clear them', async () => {
        await callTool({ title: '', description: '' });

        expect(sentPayload()).toStrictEqual({ title: '', description: '' });
    });

    it('sends an empty categories list to clear them', async () => {
        await callTool({ categories: [] });

        expect(sentPayload()).toStrictEqual({ categories: [] });
    });

    it('sends only the given sub-fields of defaultRunOptions and actorStandby without reading them first', async () => {
        await callTool({ defaultRunOptions: { timeoutSecs: 600 }, actorStandby: { idleTimeoutSecs: 60 } });

        // The one read is the Actor lookup; the API merges the sub-fields into the stored objects.
        expect(actorGetMock).toHaveBeenCalledTimes(1);
        expect(sentPayload()).toStrictEqual({
            defaultRunOptions: { timeoutSecs: 600 },
            actorStandby: { idleTimeoutSecs: 60 },
        });
    });

    it('drops the admin-only standby fields and anything else the tool does not declare', async () => {
        await callTool({
            isPublic: true,
            actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT', isTokenlessEnabled: true },
        });

        expect(sentPayload()).toStrictEqual({ actorStandby: { isEnabled: true } });
    });

    it('leaves out an empty defaultRunOptions or actorStandby', async () => {
        await callTool({ title: 'New title', defaultRunOptions: {}, actorStandby: {} });

        expect(sentPayload()).toStrictEqual({ title: 'New title' });
    });

    describe('at least one field', () => {
        it.each([
            ['no field', {}],
            ['only empty nested objects', { defaultRunOptions: {}, actorStandby: {} }],
        ])('asks for a field when given %s, before any API call', async (_label, args) => {
            const text = await callToolExpectingUserError(args);

            expect(text).toBe('Give at least one field to change.');
            expectNoApiCall();
        });
    });

    describe('rename', () => {
        it("says the Actor's URL and references changed", async () => {
            const { content, structuredContent } = await callTool({ name: 'google-maps-scraper' });

            expect(sentPayload()).toStrictEqual({ name: 'google-maps-scraper' });
            expect(structuredContent).toMatchObject({
                name: 'google-maps-scraper',
                fullName: 'john/google-maps-scraper',
            });
            expect(content[1].text).toBe(
                'Updated john/my-actor: name. The Actor is now john/google-maps-scraper; its URL and references to john/my-actor changed.',
            );
        });

        it('adds no rename note when the name stays the same', async () => {
            const { content } = await callTool({ name: 'my-actor' });

            expect(content[1].text).toBe('Updated john/my-actor: name.');
        });

        it('adds no rename note when only the letter case changes', async () => {
            const { content, structuredContent } = await callTool({ name: 'My-Actor' });

            expect(sentPayload()).toStrictEqual({ name: 'My-Actor' });
            expect(structuredContent).toMatchObject({ fullName: 'john/My-Actor' });
            expect(content[1].text).toBe('Updated john/my-actor: name.');
        });

        it('names the Actor by its stored name, not the spelling given', async () => {
            const { content } = await callTool({ actor: 'My-Actor', title: 'New title' });

            expect(actorMock).toHaveBeenNthCalledWith(1, 'john/My-Actor');
            expect(content[1].text).toBe('Updated john/my-actor: title.');
        });

        it('answers a name clash with the name given', async () => {
            actorUpdateMock.mockRejectedValue(
                apiError(409, 'actor-name-not-unique', 'Some other Actor already has this name ("taken").'),
            );

            const result = await callTool({ name: 'taken' });

            expectSoftFailInvalidInput(result);
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureHttpStatus: 409 }));
            expect(result.content[0].text).toBe('You already have an Actor named taken.');
        });
    });

    describe('name rule', () => {
        it.each(['-leading-dash', 'trailing-dash-', 'has space', 'under_score', 'dot.name', 'john/my-actor'])(
            "rejects the name '%s' before any API call",
            async (name) => {
                const text = await callToolExpectingUserError({ name });

                expect(text).toBe(ACTOR_NAME_RULE_TEXT);
                expectNoApiCall();
            },
        );

        it('checks the length of the name via ajv validation', () => {
            const tool = updateActor as HelperTool;
            expect(tool.ajvValidate({ actor: 'my-actor', name: 'ab' })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', name: 'a'.repeat(64) })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', name: 'abc' })).toBe(true);
            expect(tool.ajvValidate({ actor: 'my-actor', name: 'a'.repeat(63) })).toBe(true);
        });
    });

    describe('memory rule', () => {
        it.each([
            ['defaultRunOptions', 1000],
            ['defaultRunOptions', 384],
            ['actorStandby', 3000],
        ])('rejects %s.memoryMbytes %d, which is not a power of two, before any API call', async (field, memory) => {
            const text = await callToolExpectingUserError({ [field]: { memoryMbytes: memory } });

            expect(text).toBe(`${field}.memoryMbytes must be a power of two between 128 and 32768, like 1024 or 4096.`);
            expectNoApiCall();
        });

        it.each([128, 32768])('accepts %d MB for runs and standby runs', async (memory) => {
            await callTool({ defaultRunOptions: { memoryMbytes: memory }, actorStandby: { memoryMbytes: memory } });

            expect(sentPayload()).toStrictEqual({
                defaultRunOptions: { memoryMbytes: memory },
                actorStandby: { memoryMbytes: memory },
            });
        });

        it('checks the memory range and integer type via ajv validation', () => {
            const tool = updateActor as HelperTool;
            for (const field of ['defaultRunOptions', 'actorStandby']) {
                expect(tool.ajvValidate({ actor: 'my-actor', [field]: { memoryMbytes: 64 } })).toBe(false);
                expect(tool.ajvValidate({ actor: 'my-actor', [field]: { memoryMbytes: 65536 } })).toBe(false);
                expect(tool.ajvValidate({ actor: 'my-actor', [field]: { memoryMbytes: 1024.5 } })).toBe(false);
                expect(tool.ajvValidate({ actor: 'my-actor', [field]: { memoryMbytes: 1024 } })).toBe(true);
            }
        });
    });

    describe('input limits', () => {
        const tool = updateActor as HelperTool;

        it.each([
            ['title', 63],
            ['description', 300],
            ['seoTitle', 60],
            ['seoDescription', 200],
        ])('caps %s at %d characters', (field, maxLength) => {
            expect(tool.ajvValidate({ actor: 'my-actor', [field]: 'a'.repeat(maxLength) })).toBe(true);
            expect(tool.ajvValidate({ actor: 'my-actor', [field]: 'a'.repeat(maxLength + 1) })).toBe(false);
        });

        it('accepts category keys only, at most 3', () => {
            expect(tool.ajvValidate({ actor: 'my-actor', categories: ['AI', 'DEVELOPER_TOOLS', 'MCP_SERVERS'] })).toBe(
                true,
            );
            expect(tool.ajvValidate({ actor: 'my-actor', categories: ['Developer tools'] })).toBe(false);
            expect(
                tool.ajvValidate({ actor: 'my-actor', categories: ['AI', 'AGENTS', 'AUTOMATION', 'BUSINESS'] }),
            ).toBe(false);
        });

        it('checks the run timeout and standby limits', () => {
            expect(tool.ajvValidate({ actor: 'my-actor', defaultRunOptions: { timeoutSecs: -1 } })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', defaultRunOptions: { timeoutSecs: 1_000_000_000 } })).toBe(
                false,
            );
            expect(tool.ajvValidate({ actor: 'my-actor', defaultRunOptions: { timeoutSecs: 999_999_999 } })).toBe(true);
            expect(tool.ajvValidate({ actor: 'my-actor', actorStandby: { idleTimeoutSecs: 4 } })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', actorStandby: { idleTimeoutSecs: 5 } })).toBe(true);
            expect(tool.ajvValidate({ actor: 'my-actor', actorStandby: { desiredRequestsPerActorRun: 0 } })).toBe(
                false,
            );
            expect(tool.ajvValidate({ actor: 'my-actor', actorStandby: { maxRequestsPerActorRun: 0 } })).toBe(false);
        });

        it('rejects an empty actor via ajv validation', () => {
            expect(tool.ajvValidate({ actor: '', title: 'x' })).toBe(false);
        });

        it('requires only actor and offers no isPublic or admin-only standby field', () => {
            const { inputSchema } = tool;
            expect(inputSchema.required).toEqual(['actor']);
            expect(Object.keys(inputSchema.properties ?? {})).toEqual([
                'actor',
                'name',
                'title',
                'description',
                'seoTitle',
                'seoDescription',
                'categories',
                'isDeprecated',
                'defaultRunOptions',
                'actorStandby',
            ]);
            const standby = (inputSchema.properties as Record<string, { properties: Record<string, unknown> }>)
                .actorStandby;
            expect(Object.keys(standby.properties)).toEqual([
                'isEnabled',
                'build',
                'memoryMbytes',
                'idleTimeoutSecs',
                'desiredRequestsPerActorRun',
                'maxRequestsPerActorRun',
            ]);
        });
    });

    describe('own account', () => {
        it("refuses a username prefix that is not the caller's before any write", async () => {
            const text = await callToolExpectingUserError({ actor: 'jane/her-actor', title: 'x' });

            expect(text).toBe(
                "This tool works only with Actors of your own account (john); 'jane' names another account.",
            );
            expect(actorUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses an ID that belongs to another account before any write', async () => {
            actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor({ username: 'jane' }));

            const text = await callToolExpectingUserError({ actor: ACTOR_ID, title: 'x' });

            expect(text).toBe(
                `This tool works only with Actors of your own account (john); Actor ${ACTOR_ID} belongs to jane.`,
            );
            expect(actorUpdateMock).not.toHaveBeenCalled();
        });

        it("updates an Actor given by the caller's ID", async () => {
            actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor());

            const { content } = await callTool({ actor: ACTOR_ID, isDeprecated: true });

            expect(actorMock).toHaveBeenNthCalledWith(1, `john/${ACTOR_ID}`);
            expect(actorMock).toHaveBeenNthCalledWith(2, ACTOR_ID);
            expect(actorMock).toHaveBeenLastCalledWith('actor-1');
            expect(sentPayload()).toStrictEqual({ isDeprecated: true });
            expect(content[1].text).toBe('Updated john/my-actor: isDeprecated.');
        });

        it('rejects an invalid actor name before any API call', async () => {
            const text = await callToolExpectingUserError({ actor: 'bad name', title: 'x' });

            expect(text).toBe(ACTOR_NAME_RULE_TEXT);
            expectNoApiCall();
        });
    });

    it('reports an Actor that does not exist without writing', async () => {
        actorGetMock.mockResolvedValue(undefined);

        const text = await callToolExpectingUserError({ title: 'x' });

        expect(text).toBe("Actor 'my-actor' was not found in your account (john).");
        expect(actorUpdateMock).not.toHaveBeenCalled();
    });

    describe('API errors', () => {
        it('answers a schema violation with the API message', async () => {
            const message = 'Title is required for public Actors.';
            actorUpdateMock.mockRejectedValue(apiError(400, 'schema-validation', message));

            const result = await callTool({ title: '' });

            expectSoftFailInvalidInput(result);
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureHttpStatus: 400 }));
            expect(result.content[0].text).toBe(message);
        });

        it('answers a 403 with the API message as an auth failure', async () => {
            const message = 'You do not have permission to perform this action.';
            actorUpdateMock.mockRejectedValue(apiError(403, 'insufficient-permissions', message));

            const result = await callTool({ title: 'x' });

            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.AUTH,
                    failureHttpStatus: 403,
                }),
            );
            expect(result.content[0].text).toBe(message);
        });

        it('answers a 403 on the Actor lookup the same way', async () => {
            const message = 'You do not have permission to perform this action.';
            actorGetMock.mockRejectedValue(apiError(403, 'insufficient-permissions', message));

            const result = await callTool({ title: 'x' });

            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
            expect(result.content[0].text).toBe(message);
            expect(actorUpdateMock).not.toHaveBeenCalled();
        });

        it('answers any other 4xx with the API message', async () => {
            actorUpdateMock.mockRejectedValue(apiError(404, 'record-not-found', 'Actor was not found.'));

            const text = await callToolExpectingUserError({ title: 'x' });

            expect(text).toBe('Actor was not found.');
        });

        it('rethrows a 5xx', async () => {
            const error = apiError(500, 'internal-error', 'Internal server error.');
            actorUpdateMock.mockRejectedValue(error);

            await expect(callTool({ title: 'x' })).rejects.toBe(error);
        });
    });

    describe('result', () => {
        it('emits structuredContent that validates against the outputSchema', async () => {
            const result = await callTool({ title: 'x' });

            expect((updateActor as HelperTool).outputSchema).toBe(updateActorToolOutputSchema);
            expectSchemaConformingStructuredContent(result, updateActorToolOutputSchema);
        });

        it('returns null for the settings the Actor has no value for, still matching the outputSchema', async () => {
            actorUpdateMock.mockResolvedValue({
                id: 'actor-1',
                userId: 'user-secret',
                name: 'my-actor',
                username: 'john',
                isPublic: false,
                modifiedAt: '2026-09-23T10:00:00.000Z',
            });

            const result = await callTool({ title: '' });

            expect(result.structuredContent).toEqual({
                id: 'actor-1',
                name: 'my-actor',
                username: 'john',
                fullName: 'john/my-actor',
                title: null,
                description: null,
                seoTitle: null,
                seoDescription: null,
                categories: null,
                isPublic: false,
                isDeprecated: null,
                defaultRunOptions: null,
                actorStandby: null,
                modifiedAt: '2026-09-23T10:00:00.000Z',
            });
            expectSchemaConformingStructuredContent(result, updateActorToolOutputSchema);
        });

        it('keeps internal fields and admin-only standby fields out of the result', async () => {
            const result = await callTool({ title: 'x' });

            const serialized = JSON.stringify([result.content, result.structuredContent]);
            for (const leaked of ['user-secret', 'userId', 'deploy-secret', 'env-secret', 'tenancy', 'maxItems']) {
                expect(serialized).not.toContain(leaked);
            }
        });

        it.each([
            ['a plain update', { title: 'x' }],
            ['a rename', { name: 'new-name' }],
        ])('names no tool in the result text for %s', async (_label, args) => {
            const { content } = await callTool(args);

            for (const toolName of Object.values(HELPER_TOOLS)) {
                expect(content[1].text).not.toContain(toolName);
            }
        });
    });

    describe('description', () => {
        it('names push-actor only when it is loaded', () => {
            const tool = updateActor as HelperTool;
            expect(tool.description).toBe(tool.buildDescription?.(ALL_TOOLS_PRESENT));
            expect(tool.buildDescription?.(only(HELPER_TOOLS.ACTOR_PUSH))).toContain(
                `To change its source code, use ${HELPER_TOOLS.ACTOR_PUSH}.`,
            );
            expect(tool.buildDescription?.(only())).not.toContain(HELPER_TOOLS.ACTOR_PUSH);
        });
    });
});
