import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { deleteActor } from '../../src/tools/actors/delete_actor.js';
import { deleteActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const userGetMock = vi.fn();
const actorGetMock = vi.fn();
const actorDeleteMock = vi.fn();
const actorMock = vi.fn(() => ({ get: actorGetMock, delete: actorDeleteMock }));

const stubClient = {
    user: () => ({ get: userGetMock }),
    actor: actorMock,
} as unknown as InternalToolArgs['apifyClient'];

const ACTOR_ID = 'qGXMy0NAkWsIIb9LZ';
const DELETED_TEXT = 'Deleted john/my-actor. This cannot be undone; its unfinished runs were aborted.';

/** An Actor API document; `userId` is an internal field the tool must not leak. */
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
        userGetMock.mockResolvedValue({ username: 'john' });
        actorGetMock.mockResolvedValue(mockActor());
        actorDeleteMock.mockResolvedValue(undefined);
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

    it('deletes an Actor given by bare name under its ID and names it', async () => {
        const result = await callTool({ actor: 'my-actor' });

        expect(actorMock.mock.calls).toEqual([['john/my-actor'], ['actor-1']]);
        expect(actorDeleteMock).toHaveBeenCalledTimes(1);
        expect(actorDeleteMock).toHaveBeenCalledWith();
        expectSchemaConformingStructuredContent(result, deleteActorToolOutputSchema);
        expect(result.structuredContent).toEqual({ actorId: 'actor-1', fullName: 'john/my-actor', deleted: true });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content).toHaveLength(2);
        expect(result.content[1].text).toBe(DELETED_TEXT);
    });

    it.each(['john/my-actor', 'john~my-actor'])('deletes an Actor given as %s', async (actor) => {
        const result = await callTool({ actor });

        expect(actorMock.mock.calls).toEqual([['john/my-actor'], ['actor-1']]);
        expect(actorDeleteMock).toHaveBeenCalledTimes(1);
        expect(result.structuredContent).toEqual({ actorId: 'actor-1', fullName: 'john/my-actor', deleted: true });
    });

    it('deletes an Actor given as an ID after the name lookup misses', async () => {
        actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor());

        const result = await callTool({ actor: ACTOR_ID });

        expect(actorMock).toHaveBeenNthCalledWith(1, `john/${ACTOR_ID}`);
        expect(actorMock).toHaveBeenNthCalledWith(2, ACTOR_ID);
        // The delete goes to the ID the lookup returned.
        expect(actorMock).toHaveBeenLastCalledWith('actor-1');
        expect(actorDeleteMock).toHaveBeenCalledTimes(1);
        expect(result.structuredContent).toEqual({ actorId: 'actor-1', fullName: 'john/my-actor', deleted: true });
        expect(result.content[1].text).toBe(DELETED_TEXT);
    });

    it.each([
        [42, '42 users'],
        // The platform counts the owner, so an Actor nobody else ran has one user.
        [1, '1 user'],
    ])('refuses a public Actor with totalUsers %i, without calling delete', async (totalUsers, users) => {
        actorGetMock.mockResolvedValue(mockActor({ isPublic: true, stats: { totalUsers } }));

        const text = await callToolExpectingUserError({ actor: 'my-actor' });

        expect(text).toBe(
            `john/my-actor is public in Apify Store and has ${users}; unpublish it in Apify Console first.`,
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it("refuses a username prefix that is not the caller's before any Actor lookup", async () => {
        const text = await callToolExpectingUserError({ actor: 'jane/my-actor' });

        expect(text).toBe("This tool works only with Actors of your own account (john); 'jane' names another account.");
        expect(actorGetMock).not.toHaveBeenCalled();
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('refuses an ID that belongs to another account without calling delete', async () => {
        actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor({ username: 'jane' }));

        const text = await callToolExpectingUserError({ actor: ACTOR_ID });

        expect(text).toBe(
            `This tool works only with Actors of your own account (john); Actor ${ACTOR_ID} belongs to jane.`,
        );
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it.each(['my-actor', ACTOR_ID])('reports a missing Actor %s without calling delete', async (actor) => {
        // The client swallows a 404 on delete, so without the pre-read a typo would look like success.
        actorGetMock.mockResolvedValue(undefined);

        const text = await callToolExpectingUserError({ actor });

        expect(text).toBe(`Actor ${actor} was not found in your account.`);
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('rejects an invalid Actor name before any API call', async () => {
        const text = await callToolExpectingUserError({ actor: '-bad-' });

        expect(text).toBe(
            'Actor name must be 3 to 63 characters: letters, digits and dashes, not starting or ending with a dash.',
        );
        expect(userGetMock).not.toHaveBeenCalled();
        expect(actorMock).not.toHaveBeenCalled();
    });

    // The platform refuses a paid Actor only while it is public, which the tool refuses before the delete call.
    it.each([
        ['cannot-delete-critical-actor', 'Actor is marked as critical and cannot be deleted.'],
        ['insufficient-permissions', 'Insufficient permissions for the Actor.'],
    ])('answers a 403 %s from the delete call with the API message', async (type, message) => {
        actorDeleteMock.mockRejectedValue(apiError(403, type, message));

        const result = await callTool({ actor: 'my-actor' });

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

        const result = await callTool({ actor: 'my-actor' });

        expect(result.content[0].text).toBe('Some error.');
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: category,
                failureHttpStatus: status,
            }),
        );
    });

    it('answers a 403 from the Actor lookup with the API message, without calling delete', async () => {
        actorGetMock.mockRejectedValue(apiError(403, 'insufficient-permissions', 'Insufficient permissions.'));

        const result = await callTool({ actor: 'my-actor' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('Insufficient permissions.');
        expect(actorDeleteMock).not.toHaveBeenCalled();
    });

    it('rethrows a 5xx from the delete call', async () => {
        actorDeleteMock.mockRejectedValue(apiError(500, 'internal-error', 'Internal error'));

        await expect(callTool({ actor: 'my-actor' })).rejects.toBeInstanceOf(ApifyApiError);
    });

    // A result is built while the tool runs, where hasTool does not reach, so it names no tool at all.
    it.each([
        ['a deletion', mockActor()],
        ['a public refusal', mockActor({ isPublic: true })],
        ['a missing Actor', undefined],
    ])('names no tool and leaks no internal field in the result of %s', async (_label, actor) => {
        actorGetMock.mockResolvedValue(actor);

        const result = await callTool({ actor: 'my-actor' });

        const text = result.content.map((block) => block.text).join('\n');
        for (const toolName of Object.values(HELPER_TOOLS)) {
            expect(text).not.toContain(toolName);
        }
        expect(JSON.stringify(result)).not.toContain('user-secret');
    });
});
