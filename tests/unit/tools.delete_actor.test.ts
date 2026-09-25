import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { deleteActor } from '../../src/tools/actors/delete_actor.js';
import { deleteActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    mockUserInfo,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const actorGetMock = vi.fn();
const actorDeleteMock = vi.fn();
const runsListMock = vi.fn();
const actorMock = vi.fn(() => ({ get: actorGetMock, delete: actorDeleteMock, runs: () => ({ list: runsListMock }) }));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

const ACTOR_ID = 'qGXMy0NAkWsIIb9LZ';
const DELETED_TEXT = 'Deleted john/my-actor. This cannot be undone.';

/** An Actor API document of the caller's account; `userId` is an internal field the tool must not leak. */
function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        isPublic: false,
        stats: { totalUsers: 3 },
        ...overrides,
    };
}

/** A run list page as the API returns it for the unfinished-run check. */
function mockRunList(runIds: string[], total = runIds.length) {
    return { total, count: runIds.length, offset: 0, limit: 5, desc: true, items: runIds.map((id) => ({ id })) };
}

function apiError(status: number, type: string, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

type DeleteActorResult = TextToolResult & {
    structuredContent?: Record<string, unknown>;
    toolTelemetry?: ToolTelemetrySnapshot & { failureHttpStatus?: number };
};

const callTool = async (args: Record<string, unknown>) =>
    (await (deleteActor as HelperTool).call(stubToolCallContext(args, stubClient))) as DeleteActorResult;

/** Calls the tool expecting a soft-fail result and returns its text. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await callTool(args);
    expectSoftFailInvalidInput(result);
    return result.content[0].text;
};

describe('delete-actor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: 'user-secret' }));
        actorGetMock.mockResolvedValue(mockActor());
        actorDeleteMock.mockResolvedValue(undefined);
        runsListMock.mockResolvedValue(mockRunList([]));
    });

    it('has the expected tool name and destructive annotations', () => {
        expect(deleteActor.name).toBe(HELPER_TOOLS.ACTOR_DELETE);
        expect((deleteActor as HelperTool).outputSchema).toBe(deleteActorToolOutputSchema);
        expect(deleteActor.annotations).toEqual({
            title: 'Delete Actor',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        });
    });

    it('deletes an Actor given by ID under the ID the lookup returned and names it', async () => {
        const result = await callTool({ actor: ACTOR_ID });

        expect(actorMock.mock.calls).toEqual([[ACTOR_ID], ['actor-1'], ['actor-1']]);
        expect(actorDeleteMock).toHaveBeenCalledTimes(1);
        expect(actorDeleteMock).toHaveBeenCalledWith();
        expectSchemaConformingStructuredContent(result, deleteActorToolOutputSchema);
        expect(result.structuredContent).toEqual({
            actorId: 'actor-1',
            fullName: 'john/my-actor',
            deleted: true,
            abortedRunCount: 0,
        });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content).toHaveLength(2);
        expect(result.content[1].text).toBe(DELETED_TEXT);
    });

    it.each(['john/my-actor', 'john~my-actor'])('deletes an Actor given as %s', async (actor) => {
        const result = await callTool({ actor });

        // apify-client turns username/name into the API's username~name.
        expect(actorMock.mock.calls).toEqual([[actor], ['actor-1'], ['actor-1']]);
        expect(actorDeleteMock).toHaveBeenCalledTimes(1);
        expect(result.structuredContent).toEqual({
            actorId: 'actor-1',
            fullName: 'john/my-actor',
            deleted: true,
            abortedRunCount: 0,
        });
    });

    it('refuses while the Actor has unfinished runs, naming them, without calling delete', async () => {
        runsListMock.mockResolvedValue(mockRunList(['run-1', 'run-2']));

        const text = await callToolExpectingUserError({ actor: ACTOR_ID });

        expect(runsListMock).toHaveBeenCalledWith({
            status: ['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'],
            desc: true,
            limit: 5,
        });
        expect(text).toBe(
            'john/my-actor has 2 unfinished runs (run-1, run-2), and deleting it aborts them. Ask the user whether ' +
                'to abort them, and if so call again with abortRunningRuns set to true; otherwise wait until they finish.',
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('says there are more unfinished runs than it names', async () => {
        runsListMock.mockResolvedValue(mockRunList(['r1', 'r2', 'r3', 'r4', 'r5'], 7));

        const text = await callToolExpectingUserError({ actor: ACTOR_ID });

        expect(text).toContain('has 7 unfinished runs (r1, r2, r3, r4, r5, and more)');
    });

    it.each([
        [1, '1 unfinished run was aborted.'],
        [2, '2 unfinished runs were aborted.'],
    ])('deletes with abortRunningRuns while %i runs are unfinished and reports them', async (count, aborted) => {
        runsListMock.mockResolvedValue(mockRunList(Array.from({ length: count }, (_, i) => `run-${i}`)));

        const result = await callTool({ actor: ACTOR_ID, abortRunningRuns: true });

        expect(actorDeleteMock).toHaveBeenCalledTimes(1);
        expectSchemaConformingStructuredContent(result, deleteActorToolOutputSchema);
        expect(result.structuredContent).toEqual({
            actorId: 'actor-1',
            fullName: 'john/my-actor',
            deleted: true,
            abortedRunCount: count,
        });
        expect(result.content[1].text).toBe(`Deleted john/my-actor. This cannot be undone. ${aborted}`);
    });

    it('requires only actor in its input schema', () => {
        expect(deleteActor.inputSchema.required).toEqual(['actor']);
    });

    it.each([
        [42, '42 users'],
        // The platform counts the owner, so an Actor nobody else ran has one user.
        [1, '1 user'],
    ])('refuses a public Actor with totalUsers %i, without calling delete', async (totalUsers, users) => {
        actorGetMock.mockResolvedValue(mockActor({ isPublic: true, stats: { totalUsers } }));

        const text = await callToolExpectingUserError({ actor: ACTOR_ID });

        expect(text).toBe(
            `john/my-actor is public in Apify Store and has ${users}; unpublish it in Apify Console first. ` +
                'A paid Actor needs its monetization cancelled before it can be unpublished.',
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('refuses a public Actor without stats, leaving out the user count', async () => {
        actorGetMock.mockResolvedValue(mockActor({ isPublic: true, stats: undefined }));

        const text = await callToolExpectingUserError({ actor: ACTOR_ID });

        expect(text).toBe(
            'john/my-actor is public in Apify Store; unpublish it in Apify Console first. ' +
                'A paid Actor needs its monetization cancelled before it can be unpublished.',
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('refuses an Actor of another account without calling delete', async () => {
        // The platform deletes for anyone with write access, such as a user the Actor is shared with.
        actorGetMock.mockResolvedValue(mockActor({ userId: 'someone-else', username: 'jane' }));

        const text = await callToolExpectingUserError({ actor: 'jane/my-actor' });

        expect(text).toBe('jane/my-actor is not in your account; this tool deletes only your own Actors.');
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('refuses a public Actor of another account as not yours, not as public', async () => {
        actorGetMock.mockResolvedValue(
            mockActor({ userId: 'someone-else', username: 'apify', name: 'rag-web-browser', isPublic: true }),
        );

        const text = await callToolExpectingUserError({ actor: 'apify/rag-web-browser' });

        expect(text).toBe('apify/rag-web-browser is not in your account; this tool deletes only your own Actors.');
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it("refuses as AUTH, without claiming another owner, when the caller's account cannot be read", async () => {
        // A token with limited permissions gets no ID from users/me.
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));
        actorGetMock.mockResolvedValue(mockActor({ userId: undefined }));

        const result = await callTool({ actor: ACTOR_ID });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(
            'Could not confirm which account this token belongs to, so john/my-actor was not deleted. ' +
                'A token with limited permissions cannot read its account: use one without limits, or delete ' +
                'the Actor in Apify Console.',
        );
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({ toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.AUTH }),
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('refuses as AUTH before any request in a session without a token', async () => {
        const context = stubToolCallContext({ actor: ACTOR_ID }, stubClient);
        context.apifyToken = '';

        const result = (await (deleteActor as HelperTool).call(context)) as DeleteActorResult;

        expect(result.content[0].text).toBe('Deleting an Actor needs an Apify API token, and this session has none.');
        expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
        expect(actorMock).not.toHaveBeenCalled();
        expect(getUserInfoCached).not.toHaveBeenCalled();
    });

    it('reports a sub-resource reached by extra path segments as not found, without calling delete', async () => {
        // apify-client sends john~my-actor/runs/last, which returns the last run, not an Actor.
        actorGetMock.mockResolvedValue({ id: 'run-1', actId: 'actor-1', userId: 'user-secret', status: 'SUCCEEDED' });

        const text = await callToolExpectingUserError({ actor: 'john/my-actor/runs/last' });

        expect(text).toContain('Actor john/my-actor/runs/last not found.');
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it.each(['my-actor', ACTOR_ID])('reports a missing Actor %s without calling delete', async (actor) => {
        // The client swallows a 404 on delete, so without the pre-read a typo would look like success.
        actorGetMock.mockResolvedValue(undefined);

        const text = await callToolExpectingUserError({ actor });

        expect(text).toBe(
            `Actor ${actor} not found. Give its ID or its full name, username/name; ` +
                'a name without the username is not enough.',
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    // The platform refuses a paid Actor only while it is public, which the tool refuses before the delete call.
    it.each([
        ['cannot-delete-critical-actor', 'Actor is marked as critical and cannot be deleted.'],
        ['insufficient-permissions', 'Insufficient permissions for the Actor.'],
    ])('answers a 403 %s from the delete call with the API message', async (type, message) => {
        actorDeleteMock.mockRejectedValue(apiError(403, type, message));

        const result = await callTool({ actor: ACTOR_ID });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(message);
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.AUTH,
                failureHttpStatus: 403,
            }),
        );
    });

    it.each([
        [401, FAILURE_CATEGORY.AUTH],
        [400, FAILURE_CATEGORY.INVALID_INPUT],
    ])('records a %i from the delete call as %s', async (status, category) => {
        actorDeleteMock.mockRejectedValue(apiError(status, 'some-error', 'Some error.'));

        const result = await callTool({ actor: ACTOR_ID });

        expect(result.content[0].text).toBe('Some error.');
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: category,
                failureHttpStatus: status,
            }),
        );
    });

    it.each([
        [403, 'insufficient-permissions', 'Insufficient permissions.'],
        [401, 'token-not-valid', 'Authentication token is not valid.'],
    ])('answers a %i from the Actor lookup as AUTH, without calling delete', async (status, type, message) => {
        actorGetMock.mockRejectedValue(apiError(status, type, message));

        const result = await callTool({ actor: ACTOR_ID });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(message);
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.AUTH,
                failureHttpStatus: status,
            }),
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('rethrows a 5xx from the Actor lookup', async () => {
        actorGetMock.mockRejectedValue(apiError(500, 'internal-error', 'Internal error'));

        await expect(callTool({ actor: ACTOR_ID })).rejects.toBeInstanceOf(ApifyApiError);
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('rethrows a 5xx from the delete call', async () => {
        actorDeleteMock.mockRejectedValue(apiError(500, 'internal-error', 'Internal error'));

        await expect(callTool({ actor: ACTOR_ID })).rejects.toBeInstanceOf(ApifyApiError);
    });

    // A result is built while the tool runs, where hasTool does not reach, so it names no tool at all.
    it.each([
        ['a deletion', mockActor()],
        ['a public refusal', mockActor({ isPublic: true })],
        ['a missing Actor', undefined],
    ])('names no tool and leaks no internal field in the result of %s', async (_label, actor) => {
        actorGetMock.mockResolvedValue(actor);

        const result = await callTool({ actor: ACTOR_ID });

        const text = result.content.map((block) => block.text).join('\n');
        for (const toolName of Object.values(HELPER_TOOLS)) {
            expect(text).not.toContain(toolName);
        }
        expect(JSON.stringify(result)).not.toContain('user-secret');
    });
});
