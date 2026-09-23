import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { unpublishActor } from '../../src/tools/actors/unpublish_actor.js';
import { unpublishActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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

const ACTOR_ID = 'E2jjCZBezvAZnX8Rb';

/** A public Actor API document; `userId` is an internal field the tool must not leak. */
function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        title: 'My Actor',
        categories: ['AUTOMATION'],
        isPublic: true,
        ...overrides,
    };
}

function apiError(status: number, type: string, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

const callTool = async (args: Record<string, unknown> = {}) =>
    (await (unpublishActor as HelperTool).call(
        stubToolCallContext({ actor: 'my-actor', ...args }, stubClient),
    )) as TextToolResult & { structuredContent?: Record<string, unknown>; toolTelemetry?: ToolTelemetrySnapshot };

describe('unpublish-actor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userGetMock.mockResolvedValue({ username: 'john', id: 'user-secret' });
        actorGetMock.mockResolvedValue(mockActor());
        actorUpdateMock.mockResolvedValue(mockActor({ isPublic: false }));
    });

    it('unpublishes the Actor with an update that sets only isPublic', async () => {
        const result = await callTool();

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        expect(actorMock).toHaveBeenLastCalledWith('actor-1');
        expect(actorUpdateMock.mock.calls).toEqual([[{ isPublic: false }]]);
        expect(result.structuredContent).toEqual({ id: 'actor-1', fullName: 'john/my-actor', isPublic: false });
        expect(result.content).toHaveLength(2);
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content[1].text).toBe('john/my-actor is now private and no longer listed in Apify Store.');
        expect(JSON.stringify(result)).not.toContain('user-secret');
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        expect((unpublishActor as HelperTool).outputSchema).toBe(unpublishActorToolOutputSchema);
        expectSchemaConformingStructuredContent(await callTool(), unpublishActorToolOutputSchema);
    });

    it('returns success without an update when the Actor is already private', async () => {
        actorGetMock.mockResolvedValue(mockActor({ isPublic: false }));

        const result = await callTool();

        expect(actorUpdateMock).not.toHaveBeenCalled();
        expectSchemaConformingStructuredContent(result, unpublishActorToolOutputSchema);
        expect(result.structuredContent).toEqual({ id: 'actor-1', fullName: 'john/my-actor', isPublic: false });
        expect(result.content[1].text).toBe('john/my-actor is already private.');
    });

    it.each([
        [
            'cannot-unpublish-paid-actor',
            'Unpublishing paid Actors is not possible. You need to cancel the monetization first. If you really need to unpublish, please contact support@apify.com',
        ],
        ['cannot-unpublish-critical-actor', 'Actor is marked as critical and cannot be unpublished.'],
    ])('answers a 403 %s rejection with the API message', async (type, message) => {
        actorUpdateMock.mockRejectedValue(apiError(403, type, message));

        const result = await callTool();

        expectSoftFailInvalidInput(result);
        expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureHttpStatus: 403, failureDetail: type }));
        expect(result.content).toEqual([{ type: 'text', text: message }]);
        expect(actorUpdateMock.mock.calls).toEqual([[{ isPublic: false }]]);
    });

    it('rethrows a server error from the update', async () => {
        const error = apiError(500, 'internal-error', 'Internal server failure');
        actorUpdateMock.mockRejectedValue(error);

        await expect(callTool()).rejects.toBe(error);
    });

    it('reports an Actor that does not exist as not found', async () => {
        actorGetMock.mockResolvedValue(undefined);

        const result = await callTool();

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe("Actor 'my-actor' not found.");
        expect(actorUpdateMock).not.toHaveBeenCalled();
    });

    it("refuses a username prefix that is not the caller's before any Actor lookup", async () => {
        const result = await callTool({ actor: 'jane/my-actor' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            "This tool works only with Actors of your own account (john); 'jane' names another account.",
        );
        expect(actorGetMock).not.toHaveBeenCalled();
        expect(actorUpdateMock).not.toHaveBeenCalled();
    });

    it('refuses an ID that belongs to another account', async () => {
        actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor({ username: 'jane' }));

        const result = await callTool({ actor: ACTOR_ID });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            `This tool works only with Actors of your own account (john); Actor ${ACTOR_ID} belongs to jane.`,
        );
        expect(actorUpdateMock).not.toHaveBeenCalled();
    });

    it("unpublishes by ID when the ID is one of the caller's Actors", async () => {
        actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor({ id: ACTOR_ID }));

        const { structuredContent } = await callTool({ actor: ACTOR_ID });

        expect(actorMock).toHaveBeenLastCalledWith(ACTOR_ID);
        expect(actorUpdateMock.mock.calls).toEqual([[{ isPublic: false }]]);
        expect(structuredContent).toMatchObject({ id: ACTOR_ID, fullName: 'john/my-actor' });
    });

    it('rejects an invalid Actor name without calling the API', async () => {
        const result = await callTool({ actor: 'my_actor' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('Actor name must be 3 to 63 characters');
        expect(userGetMock).not.toHaveBeenCalled();
    });

    it('names no tool in the result text', async () => {
        const results = [await callTool()];
        actorGetMock.mockResolvedValue(mockActor({ isPublic: false }));
        results.push(await callTool());

        for (const { content } of results) {
            for (const toolName of Object.values(HELPER_TOOLS)) {
                expect(content.map(({ text }) => text).join('\n')).not.toContain(toolName);
            }
        }
    });

    describe('description', () => {
        it('names the publish tool when it is served', () => {
            const { description } = unpublishActor as HelperTool;

            expect(description).toBe((unpublishActor as HelperTool).buildDescription?.(ALL_TOOLS_PRESENT));
            expect(description).toContain(`published again later with ${HELPER_TOOLS.ACTOR_PUBLISH}.`);
            expect(description).toContain('Paid Actors and Actors marked as critical cannot be unpublished.');
        });

        it('names no tool when none is served', () => {
            const description = (unpublishActor as HelperTool).buildDescription?.(only()) ?? '';

            for (const toolName of Object.values(HELPER_TOOLS)) {
                expect(description).not.toContain(toolName);
            }
            expect(description).toContain('so it can be published again later.');
        });
    });

    it('declares unpublishing destructive and idempotent, with no payment', () => {
        const tool = unpublishActor as HelperTool;

        expect(tool.name).toBe(HELPER_TOOLS.ACTOR_UNPUBLISH);
        expect(tool.annotations).toEqual({
            title: 'Unpublish Actor',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect(tool.paymentRequired).toBeUndefined();
    });

    it('requires a non-empty actor', () => {
        const tool = unpublishActor as HelperTool;

        expect(tool.inputSchema.required).toEqual(['actor']);
        expect(tool.ajvValidate({})).toBe(false);
        expect(tool.ajvValidate({ actor: '' })).toBe(false);
        expect(tool.ajvValidate({ actor: 'my-actor' })).toBe(true);
    });
});
