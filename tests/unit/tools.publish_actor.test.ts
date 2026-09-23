import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { publishActor } from '../../src/tools/actors/publish_actor.js';
import { publishActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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

/** A private Actor API document; `userId` is an internal field the tool must not leak. */
function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        title: 'My Actor',
        categories: ['AUTOMATION'],
        isPublic: false,
        ...overrides,
    };
}

function apiError(status: number, type: string, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

const callTool = async (args: Record<string, unknown> = {}) =>
    (await (publishActor as HelperTool).call(
        stubToolCallContext({ actor: 'my-actor', ...args }, stubClient),
    )) as TextToolResult & { structuredContent?: Record<string, unknown>; toolTelemetry?: ToolTelemetrySnapshot };

describe('publish-actor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userGetMock.mockResolvedValue({ username: 'john', id: 'user-secret' });
        actorGetMock.mockResolvedValue(mockActor());
        actorUpdateMock.mockResolvedValue(mockActor({ isPublic: true }));
    });

    it('publishes the Actor with an update that sets only isPublic', async () => {
        const result = await callTool();

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        expect(actorMock).toHaveBeenLastCalledWith('actor-1');
        expect(actorUpdateMock.mock.calls).toEqual([[{ isPublic: true }]]);
        expect(result.structuredContent).toEqual({
            id: 'actor-1',
            fullName: 'john/my-actor',
            isPublic: true,
            storeUrl: 'https://apify.com/john/my-actor',
        });
        expect(result.content).toHaveLength(2);
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content[1].text).toBe(
            'john/my-actor is now public in Apify Store; its Store page is https://apify.com/john/my-actor.',
        );
        expect(JSON.stringify(result)).not.toContain('user-secret');
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        expect((publishActor as HelperTool).outputSchema).toBe(publishActorToolOutputSchema);
        expectSchemaConformingStructuredContent(await callTool(), publishActorToolOutputSchema);
    });

    it('builds the Store URL from the account spelling of the username', async () => {
        const { structuredContent } = await callTool({ actor: 'John~my-actor' });

        expect(structuredContent).toMatchObject({
            fullName: 'john/my-actor',
            storeUrl: 'https://apify.com/john/my-actor',
        });
    });

    it('returns success without an update when the Actor is already public', async () => {
        actorGetMock.mockResolvedValue(mockActor({ isPublic: true }));

        const result = await callTool();

        expect(actorUpdateMock).not.toHaveBeenCalled();
        expectSchemaConformingStructuredContent(result, publishActorToolOutputSchema);
        expect(result.structuredContent).toEqual({
            id: 'actor-1',
            fullName: 'john/my-actor',
            isPublic: true,
            storeUrl: 'https://apify.com/john/my-actor',
        });
        expect(result.content[1].text).toBe('john/my-actor is already public in Apify Store.');
    });

    it.each([
        ['no title', { title: undefined }],
        ['an empty title', { title: '' }],
        ['no categories', { categories: undefined }],
        ['an empty category list', { categories: [] }],
    ])('refuses an Actor with %s before calling the API', async (_label, overrides) => {
        actorGetMock.mockResolvedValue(mockActor(overrides));

        const result = await callTool();

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe('Publishing needs a title and at least one category; set them first.');
        expect(actorUpdateMock).not.toHaveBeenCalled();
    });

    it.each([
        [400, 'schema-validation', 'Invalid value provided in updatedActor: seoTitle is too long'],
        [403, 'username-required', 'Actor owner needs to have a username set in order to publish the Actor.'],
        [403, 'username-required', 'Actor owner needs to have a public profile in order to publish the Actor.'],
        [403, 'tagged-build-required', 'The Actor needs to have at least one build with a tag.'],
        [
            403,
            'store-terms-not-accepted',
            'The Actor owner must accept the Apify Store terms and conditions to publish the Actor. Visit https://console.apify.com/actors/actor-1?tab=publication to accept them.',
        ],
        [
            403,
            'readme-required',
            "This Actor can't be published because its default build has no README. Add a README.md to the source code, rebuild, and publish again.",
        ],
        [
            403,
            'schemas-required',
            "This Actor can't be published because its default build has no input or output schema. Add the missing schema to the source code, rebuild, and publish again.",
        ],
        [
            403,
            'cannot-publish-actor',
            'The Actor cannot be published at this time. Please contact support@apify.com for assistance in resolving the issue.',
        ],
        [
            429,
            'daily-publication-limit-exceeded',
            'You’ve reached the daily limit of 5 Actor publications. Try again in 24 hours.',
        ],
    ])('answers a %i %s rejection with the API message', async (status, type, message) => {
        actorUpdateMock.mockRejectedValue(apiError(status, type, message));

        const result = await callTool();

        expectSoftFailInvalidInput(result);
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({ failureHttpStatus: status, failureDetail: type }),
        );
        expect(result.content).toEqual([{ type: 'text', text: message }]);
        expect(actorUpdateMock.mock.calls).toEqual([[{ isPublic: true }]]);
    });

    it('rethrows a server error from the update', async () => {
        const error = apiError(500, 'internal-error', 'Internal server failure');
        actorUpdateMock.mockRejectedValue(error);

        await expect(callTool()).rejects.toBe(error);
    });

    it('leaves a failed read to the generic error mapper, which reports it as an auth failure', async () => {
        const error = apiError(401, 'token-not-valid', 'Authentication token is not valid.');
        userGetMock.mockRejectedValue(error);

        await expect(callTool()).rejects.toBe(error);
        expect(actorUpdateMock).not.toHaveBeenCalled();
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

    it("publishes by ID when the ID is one of the caller's Actors", async () => {
        actorGetMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(mockActor({ id: ACTOR_ID }));

        const { structuredContent } = await callTool({ actor: ACTOR_ID });

        expect(actorMock).toHaveBeenLastCalledWith(ACTOR_ID);
        expect(actorUpdateMock.mock.calls).toEqual([[{ isPublic: true }]]);
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
        actorGetMock.mockResolvedValue(mockActor({ isPublic: true }));
        results.push(await callTool());
        actorGetMock.mockResolvedValue(mockActor({ title: undefined }));
        results.push(await callTool());

        for (const { content } of results) {
            for (const toolName of Object.values(HELPER_TOOLS)) {
                expect(content.map(({ text }) => text).join('\n')).not.toContain(toolName);
            }
        }
    });

    describe('description', () => {
        it('names the unpublish tool and the tools that fix a failed publication when they are served', () => {
            const { description } = publishActor as HelperTool;

            expect(description).toBe((publishActor as HelperTool).buildDescription?.(ALL_TOOLS_PRESENT));
            expect(description).toContain(`Use ${HELPER_TOOLS.ACTOR_UNPUBLISH} to remove it from Apify Store again.`);
            expect(description).toContain(`with ${HELPER_TOOLS.ACTOR_PUSH}`);
            expect(description).toContain(`with ${HELPER_TOOLS.ACTOR_BUILD}`);
            expect(description).toContain(`with ${HELPER_TOOLS.ACTOR_CALL}`);
        });

        it('names no tool when none is served, keeping the requirements and the daily limit', () => {
            const description = (publishActor as HelperTool).buildDescription?.(only()) ?? '';

            for (const toolName of Object.values(HELPER_TOOLS)) {
                expect(description).not.toContain(toolName);
            }
            expect(description).toContain('If publishing fails, follow the API reason.');
            expect(description).toContain('At most 5 Actors can be published per rolling 24 hours.');
        });
    });

    it('declares publishing destructive and idempotent, with no payment', () => {
        const tool = publishActor as HelperTool;

        expect(tool.name).toBe(HELPER_TOOLS.ACTOR_PUBLISH);
        expect(tool.annotations).toEqual({
            title: 'Publish Actor',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect(tool.paymentRequired).toBeUndefined();
    });

    it('requires a non-empty actor', () => {
        const tool = publishActor as HelperTool;

        expect(tool.inputSchema.required).toEqual(['actor']);
        expect(tool.ajvValidate({})).toBe(false);
        expect(tool.ajvValidate({ actor: '' })).toBe(false);
        expect(tool.ajvValidate({ actor: 'my-actor' })).toBe(true);
    });
});
