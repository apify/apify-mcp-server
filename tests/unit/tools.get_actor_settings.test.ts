import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { getActorSettings } from '../../src/tools/actors/get_actor_settings.js';
import { actorSettingsOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const ACTOR_ID = 'qGXMy0NAkWsIIb9LZ';

const userGetMock = vi.fn();
const userMock = vi.fn(() => ({ get: userGetMock }));
const actorGetMock = vi.fn();
const actorMock = vi.fn(() => ({ get: actorGetMock }));

const stubClient = { user: userMock, actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

/**
 * An Actor API document as the owner gets it: env var values in plaintext, secret ones as a hash, plus
 * internal fields (`userId`, `deploymentKey`, `stats`, source files) the tool must not return.
 */
function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: ACTOR_ID,
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        title: 'My Actor',
        description: 'Scrapes product pages.',
        seoTitle: 'My Actor for products',
        seoDescription: 'Scrape product pages fast.',
        categories: ['ECOMMERCE'],
        isPublic: false,
        isDeprecated: false,
        deploymentKey: 'deployment-key-secret',
        restartOnError: false,
        stats: { totalRuns: 3, totalBuilds: 2 },
        defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 3600, restartOnError: false },
        actorStandby: {
            isEnabled: true,
            build: 'beta',
            memoryMbytes: 512,
            idleTimeoutSecs: 300,
            desiredRequestsPerActorRun: 4,
            maxRequestsPerActorRun: 8,
            shouldPassActorInput: true,
            disableStandbyFieldsOverride: false,
        },
        versions: [
            {
                versionNumber: '0.1',
                sourceType: 'SOURCE_FILES',
                buildTag: 'latest',
                applyEnvVarsToBuild: false,
                sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("source");' }],
                envVars: [
                    { name: 'API_URL', value: 'plain-env-value', isSecret: false },
                    { name: 'API_KEY', value: 'secret-env-value', isSecret: true, valueHash: 'a1b2c3' },
                ],
            },
            {
                versionNumber: '0.2',
                sourceType: 'GIT_REPO',
                buildTag: 'beta',
                gitRepoUrl: 'https://github.com/john/my-actor',
            },
        ],
        taggedBuilds: {
            latest: { buildId: 'build-1', buildNumber: '0.1.3', finishedAt: new Date('2026-09-01T10:01:00.000Z') },
            beta: { buildId: 'build-2', buildNumber: '0.2.1' },
        },
        createdAt: new Date('2026-08-01T09:00:00.000Z'),
        modifiedAt: new Date('2026-09-01T10:02:00.000Z'),
        ...overrides,
    };
}

const EXPECTED_SETTINGS = {
    id: ACTOR_ID,
    name: 'my-actor',
    username: 'john',
    fullName: 'john/my-actor',
    title: 'My Actor',
    description: 'Scrapes product pages.',
    seoTitle: 'My Actor for products',
    seoDescription: 'Scrape product pages fast.',
    categories: ['ECOMMERCE'],
    isPublic: false,
    isDeprecated: false,
    defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 3600 },
    actorStandby: {
        isEnabled: true,
        build: 'beta',
        memoryMbytes: 512,
        idleTimeoutSecs: 300,
        desiredRequestsPerActorRun: 4,
        maxRequestsPerActorRun: 8,
    },
    versions: [
        {
            versionNumber: '0.1',
            sourceType: 'SOURCE_FILES',
            buildTag: 'latest',
            envVars: [
                { name: 'API_URL', isSecret: false },
                { name: 'API_KEY', isSecret: true },
            ],
        },
        { versionNumber: '0.2', sourceType: 'GIT_REPO', buildTag: 'beta', envVars: null },
    ],
    taggedBuilds: {
        latest: { buildId: 'build-1', buildNumber: '0.1.3', finishedAt: '2026-09-01T10:01:00.000Z' },
        beta: { buildId: 'build-2', buildNumber: '0.2.1', finishedAt: null },
    },
    createdAt: '2026-08-01T09:00:00.000Z',
    modifiedAt: '2026-09-01T10:02:00.000Z',
};

function apiError(status: number, message = 'Forbidden'): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: 'forbidden', message } }, status } as AxiosResponse, 1);
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext(args, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (getActorSettings as HelperTool).call(context)) as TextToolResult;
};

/** Calls the tool expecting an INVALID_INPUT soft fail and returns its only text block. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await (getActorSettings as HelperTool).call(stubToolCallContext(args, stubClient));
    expectSoftFailInvalidInput(result);
    const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };
    expect(structuredContent).toBeUndefined();
    expect(content).toHaveLength(1);
    return content[0].text;
};

describe('get-actor-settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userGetMock.mockResolvedValue({ id: 'user-secret', username: 'john' });
        actorGetMock.mockResolvedValue(mockActor());
    });

    it('has the expected tool name', () => {
        expect(getActorSettings.name).toBe(HELPER_TOOLS.ACTOR_SETTINGS_GET);
    });

    it('returns the settings of an own Actor given by bare name', async () => {
        const { content, structuredContent } = await callTool({ actor: 'my-actor' });

        expect(userMock).toHaveBeenCalledWith('me');
        expect(actorMock).toHaveBeenCalledTimes(1);
        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        expect(actorGetMock).toHaveBeenCalledWith();
        expect(structuredContent).toEqual(EXPECTED_SETTINGS);
        // content: [0] data, [1] summary.
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toBe('Settings of john/my-actor: 2 versions, public: no.');
    });

    it('returns the settings of an own Actor given as username/name', async () => {
        const { structuredContent } = await callTool({ actor: 'john/my-actor' });

        expect(actorMock).toHaveBeenCalledTimes(1);
        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        expect(structuredContent).toEqual(EXPECTED_SETTINGS);
    });

    it('returns the settings of an own Actor given by ID, after the name lookup misses', async () => {
        actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor());

        const { structuredContent } = await callTool({ actor: ACTOR_ID });

        expect(actorMock).toHaveBeenNthCalledWith(1, `john/${ACTOR_ID}`);
        expect(actorMock).toHaveBeenNthCalledWith(2, ACTOR_ID);
        expect(structuredContent).toEqual(EXPECTED_SETTINGS);
    });

    it('says public: yes and uses the singular for one version', async () => {
        actorGetMock.mockResolvedValue(mockActor({ isPublic: true, versions: [mockActor().versions[0]] }));

        const { content } = await callTool({ actor: 'my-actor' });

        expect(content[1].text).toBe('Settings of john/my-actor: 1 version, public: yes.');
    });

    it('returns null for fields the API omits', async () => {
        const omittedFields = new Set([
            'title',
            'description',
            'seoTitle',
            'seoDescription',
            'categories',
            'isDeprecated',
            'actorStandby',
            'taggedBuilds',
        ]);
        const actor = mockActor({ versions: [{ sourceType: 'SOURCE_FILES', envVars: [{ name: 'EMPTY' }] }] });
        actorGetMock.mockResolvedValue(
            Object.fromEntries(Object.entries(actor).filter(([field]) => !omittedFields.has(field))),
        );

        const result = await callTool({ actor: 'my-actor' });

        expect(result.structuredContent).toEqual({
            ...EXPECTED_SETTINGS,
            title: null,
            description: null,
            seoTitle: null,
            seoDescription: null,
            categories: null,
            isDeprecated: null,
            actorStandby: null,
            versions: [
                {
                    versionNumber: null,
                    sourceType: 'SOURCE_FILES',
                    buildTag: null,
                    envVars: [{ name: 'EMPTY', isSecret: null }],
                },
            ],
            taggedBuilds: null,
        });
        expectSchemaConformingStructuredContent(result, actorSettingsOutputSchema);
    });

    it('returns standby settings the API leaves partly unset as null', async () => {
        actorGetMock.mockResolvedValue(mockActor({ actorStandby: { isEnabled: false } }));

        const result = await callTool({ actor: 'my-actor' });

        expect((result.structuredContent as { actorStandby: unknown }).actorStandby).toEqual({
            isEnabled: false,
            build: null,
            memoryMbytes: null,
            idleTimeoutSecs: null,
            desiredRequestsPerActorRun: null,
            maxRequestsPerActorRun: null,
        });
        expectSchemaConformingStructuredContent(result, actorSettingsOutputSchema);
    });

    it('never returns an environment variable value or value hash', async () => {
        const result = await callTool({ actor: 'my-actor' });
        const resultJson = JSON.stringify(result);

        expect(resultJson).toContain('API_KEY');
        expect(resultJson).not.toContain('plain-env-value');
        expect(resultJson).not.toContain('secret-env-value');
        expect(resultJson).not.toContain('a1b2c3');
        expect(resultJson).not.toContain('valueHash');
        expect(resultJson).not.toMatch(/\\?"value\\?"/);
    });

    it('does not leak userId or other internal Actor fields', async () => {
        const resultJson = JSON.stringify(await callTool({ actor: 'my-actor' }));

        expect(resultJson).not.toContain('user-secret');
        expect(resultJson).not.toContain('userId');
        expect(resultJson).not.toContain('deployment-key-secret');
        expect(resultJson).not.toContain('totalRuns');
        expect(resultJson).not.toContain('console.log');
        expect(resultJson).not.toContain('github.com/john/my-actor');
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        const result = await callTool({ actor: 'my-actor' });

        expect((getActorSettings as HelperTool).outputSchema).toBe(actorSettingsOutputSchema);
        expectSchemaConformingStructuredContent(result, actorSettingsOutputSchema);
    });

    it('refuses an Actor of another account given as username/name without reading it', async () => {
        const text = await callToolExpectingUserError({ actor: 'jane/my-actor' });

        expect(text).toBe("This tool works only with Actors of your own account (john); 'jane' names another account.");
        expect(actorMock).not.toHaveBeenCalled();
    });

    it('refuses an ID of an Actor that belongs to another account', async () => {
        actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor({ username: 'jane' }));

        const text = await callToolExpectingUserError({ actor: ACTOR_ID });

        expect(text).toBe(
            `This tool works only with Actors of your own account (john); Actor ${ACTOR_ID} belongs to jane.`,
        );
    });

    it('reports an Actor that is not in the account as not found', async () => {
        actorGetMock.mockResolvedValue(undefined);

        const text = await callToolExpectingUserError({ actor: 'missing-actor' });

        expect(text).toBe("No Actor 'missing-actor' in your account (john).");
        expect(actorMock).toHaveBeenCalledTimes(1);
        expect(actorMock).toHaveBeenCalledWith('john/missing-actor');
    });

    it('reports an ID that matches no Actor as not found', async () => {
        actorGetMock.mockResolvedValue(undefined);

        const text = await callToolExpectingUserError({ actor: ACTOR_ID });

        expect(text).toBe(`No Actor '${ACTOR_ID}' in your account (john).`);
        expect(actorMock).toHaveBeenCalledWith(ACTOR_ID);
    });

    it('rejects an invalid Actor name without calling the API', async () => {
        const text = await callToolExpectingUserError({ actor: 'my_actor' });

        expect(text).toBe(
            'Actor name must be 3 to 63 characters: letters, digits and dashes, not starting or ending with a dash.',
        );
        expect(userGetMock).not.toHaveBeenCalled();
        expect(actorMock).not.toHaveBeenCalled();
    });

    it('maps a 403 from the account lookup, which scoped tokens get, to a permission error', async () => {
        userGetMock.mockRejectedValue(apiError(403));

        const result = await callTool({ actor: 'my-actor' });

        expect(result.isError).toBe(true);
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.AUTH,
                failureHttpStatus: 403,
            }),
        );
        expect(result.content[0].text).toBe(
            'The token is not allowed to read Actors in this account; scoped tokens cannot look up the account this tool needs. Use a token with full access.',
        );
    });

    it('rethrows other API errors', async () => {
        actorGetMock.mockRejectedValue(apiError(500, 'Internal server failure'));

        await expect(callTool({ actor: 'my-actor' })).rejects.toBeInstanceOf(ApifyApiError);
    });

    it.each([
        ['every tool is loaded', Object.values(HELPER_TOOLS)],
        ['only this tool is loaded', [HELPER_TOOLS.ACTOR_SETTINGS_GET]],
    ])('names no tool in the result text when %s', async (_label, loadedToolNames) => {
        const { content } = await callTool({ actor: 'my-actor' }, loadedToolNames);

        for (const toolName of Object.values(HELPER_TOOLS)) {
            expect(content[1].text).not.toContain(toolName);
        }
    });

    it('names fetch-actor-details in the description only when that tool is in the session', () => {
        const tool = getActorSettings as HelperTool;
        expect(tool.description).toContain(
            `For the Store view of an Actor (README, input schema, pricing), use ${HELPER_TOOLS.ACTOR_GET_DETAILS}.`,
        );
        const withoutDetails = tool.buildDescription?.(only(HELPER_TOOLS.ACTOR_SETTINGS_GET));
        expect(withoutDetails).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(withoutDetails).not.toContain('Store view');
    });

    it('rejects an empty or missing actor via ajv validation', () => {
        const tool = getActorSettings as HelperTool;
        expect(tool.ajvValidate({ actor: '' })).toBe(false);
        expect(tool.ajvValidate({})).toBe(false);
        expect(tool.ajvValidate({ actor: 'my-actor' })).toBe(true);
    });

    it('requires only actor in the input schema', () => {
        expect(getActorSettings.inputSchema.required).toEqual(['actor']);
    });
});
