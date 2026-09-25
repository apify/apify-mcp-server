import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../src/const.js';
import { deleteActorVersion } from '../../src/tools/source/delete_actor_version.js';
import { deleteActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockUserInfo,
    only,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const actorGetMock = vi.fn();
const versionDeleteMock = vi.fn();
const versionMock = vi.fn(() => ({ delete: versionDeleteMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock }));

const stubClient = {
    actor: actorMock,
    baseUrl: 'https://api.example.test/v2',
} as unknown as InternalToolArgs['apifyClient'];

const TOOL_NAMES = Object.values(HELPER_TOOLS);

type DeleteResult = TextToolResult & {
    structuredContent: { actorId: string; fullName: string; versionNumber: string; deleted: boolean };
    toolTelemetry?: ToolTelemetrySnapshot;
};

function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
        userId: 'user-1',
        name: 'my-actor',
        username: 'john',
        versions: [
            { versionNumber: '0.1', sourceType: 'SOURCE_FILES', buildTag: 'latest' },
            { versionNumber: '0.2', sourceType: 'SOURCE_FILES' },
        ],
        ...overrides,
    };
}

function apiError(status: number, message: string, type = 'some-error'): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

async function callTool(
    args: Record<string, unknown>,
    loadedToolNames?: string[],
    signal?: AbortSignal,
): Promise<DeleteResult> {
    const context = stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.2', ...args }, stubClient);
    const withTools = loadedToolNames === undefined ? context : { ...context, loadedToolNames };
    const withSignal = signal === undefined ? withTools : { ...withTools, signal };
    return (await (deleteActorVersion as HelperTool).call(withSignal)) as DeleteResult;
}

async function callToolExpectingUserError(args: Record<string, unknown>) {
    const result = await callTool(args);
    expectSoftFailInvalidInput(result);
    return result.content[0].text;
}

const LAST_VERSION_TEXT =
    'Nothing was deleted: version 0.1 is the only version of john/my-actor, and an Actor must keep at least one ' +
    'version. To remove it, delete the Actor instead.';

describe('delete-actor-version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: 'user-1' }));
        actorGetMock.mockResolvedValue(mockActor());
        versionDeleteMock.mockResolvedValue(undefined);
    });

    it('is a destructive, idempotent, closed-world tool without payment', () => {
        expect(deleteActorVersion.name).toBe(HELPER_TOOLS.ACTOR_VERSION_DELETE);
        expect(deleteActorVersion.annotations).toEqual({
            title: 'Delete Actor version',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect((deleteActorVersion as HelperTool).paymentRequired).toBeUndefined();
    });

    it('names create-actor-version in its description only when the session has it', () => {
        const { buildDescription } = deleteActorVersion as HelperTool;
        const full = buildDescription?.(only(HELPER_TOOLS.ACTOR_VERSION_CREATE)) ?? '';
        expect(full).toBe(deleteActorVersion.description);
        expect(full).toContain(`such as a working copy made with ${HELPER_TOOLS.ACTOR_VERSION_CREATE}.`);
        const bare = buildDescription?.(only()) ?? '';
        for (const name of TOOL_NAMES.filter((tool) => tool !== HELPER_TOOLS.ACTOR_VERSION_DELETE)) {
            expect(bare).not.toContain(name);
        }
        expect(full).not.toMatch(/[–—]/);
    });

    it('names no tool in the input schema', () => {
        const schemaText = JSON.stringify(deleteActorVersion.inputSchema);
        for (const name of TOOL_NAMES) expect(schemaText).not.toContain(name);
    });

    it('deletes the version with one DELETE and says its builds and tags stay', async () => {
        const result = await callTool({});
        expectSchemaConformingStructuredContent(result, deleteActorVersionToolOutputSchema);
        expect(actorMock).toHaveBeenCalledWith('actor-1');
        expect(versionMock).toHaveBeenCalledWith('0.2');
        expect(versionDeleteMock).toHaveBeenCalledTimes(1);
        expect(result.structuredContent).toEqual({
            actorId: 'actor-1',
            fullName: 'john/my-actor',
            versionNumber: '0.2',
            deleted: true,
        });
        expect(result.content[1].text).toBe(
            'Deleted version 0.2 of john/my-actor. Its builds stay, and so do the tags that point to them: a run ' +
                'with such a tag still uses that build.',
        );
    });

    it('refuses a version the Actor does not have, before any DELETE', async () => {
        expect(await callToolExpectingUserError({ versionNumber: '0.9' })).toBe(
            "Actor 'john/my-actor' has no version 0.9; available versions: 0.1, 0.2.",
        );
        expect(versionDeleteMock).not.toHaveBeenCalled();
    });

    it('refuses the last version before any DELETE, naming no tool', async () => {
        actorGetMock.mockResolvedValue(mockActor({ versions: [{ versionNumber: '0.1', sourceType: 'SOURCE_FILES' }] }));
        const text = await callToolExpectingUserError({ versionNumber: '0.1' });
        expect(text).toBe(LAST_VERSION_TEXT);
        for (const name of TOOL_NAMES) expect(text).not.toContain(name);
        expect(versionDeleteMock).not.toHaveBeenCalled();
    });

    it("maps the platform's too-few-versions refusal to the same user error", async () => {
        versionDeleteMock.mockRejectedValue(
            apiError(403, 'The Actor must have at least 1 versions', 'too-few-versions'),
        );
        expect(await callToolExpectingUserError({ versionNumber: '0.1' })).toBe(LAST_VERSION_TEXT);
    });

    it('sends nothing when the request is cancelled before the DELETE', async () => {
        const controller = new AbortController();
        actorGetMock.mockImplementation(async () => {
            controller.abort();
            return mockActor();
        });
        const result = await callTool({}, undefined, controller.signal);
        expect(result).toEqual({});
        expect(versionDeleteMock).not.toHaveBeenCalled();
    });

    describe('ownership', () => {
        it('refuses a session without a token before any request', async () => {
            const context = {
                ...stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.2' }, stubClient),
                apifyToken: '',
            };
            const result = (await (deleteActorVersion as HelperTool).call(context)) as DeleteResult;
            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('refuses an Actor that does not exist or a bare name', async () => {
            actorGetMock.mockResolvedValue(undefined);
            expect(await callToolExpectingUserError({ actor: 'my-actor' })).toBe(
                'Actor my-actor not found. Give its ID or its full name, username/name; a name without the username is not enough.',
            );
            expect(versionDeleteMock).not.toHaveBeenCalled();
        });

        it('refuses when the account cannot be confirmed', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));
            const result = await callTool({});
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
            expect(versionDeleteMock).not.toHaveBeenCalled();
        });

        it("refuses someone else's Actor", async () => {
            actorGetMock.mockResolvedValue(mockActor({ userId: 'someone-else' }));
            expect(await callToolExpectingUserError({})).toBe(
                'john/my-actor is not in your account; this tool changes only your own Actors.',
            );
            expect(versionDeleteMock).not.toHaveBeenCalled();
        });
    });

    describe('API errors', () => {
        it('returns a 4xx from the DELETE as the API message', async () => {
            versionDeleteMock.mockRejectedValue(apiError(403, 'Insufficient permissions'));
            const result = await callTool({});
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Insufficient permissions');
        });

        it('rethrows a 5xx', async () => {
            versionDeleteMock.mockRejectedValue(apiError(500, 'Internal'));
            await expect(callTool({})).rejects.toThrow('Internal');
        });
    });
});
