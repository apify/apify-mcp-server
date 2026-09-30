import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { deleteActorVersion } from '../../src/tools/source/delete_actor_version.js';
import { deleteActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const actorGetMock = vi.fn();
const versionDeleteMock = vi.fn();
// The version client's other writes, which this tool never calls.
const versionUpdateMock = vi.fn();
const versionMock = vi.fn(() => ({ delete: versionDeleteMock, update: versionUpdateMock }));
// The Actor client's methods that change or delete the Actor, create a version, or build, which this tool never calls.
const actorWriteMocks = { update: vi.fn(), delete: vi.fn(), versions: vi.fn(), build: vi.fn() };
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock, ...actorWriteMocks }));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

type DeleteResult = TextToolResult & {
    structuredContent: { actorId: string; fullName: string; versionNumber: string; deleted: boolean };
    toolTelemetry?: ToolTelemetrySnapshot;
};

function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
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

async function callTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<DeleteResult> {
    const context = stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.2', ...args }, stubClient);
    const withSignal = signal === undefined ? context : { ...context, signal };
    return (await (deleteActorVersion as HelperTool).call(withSignal)) as DeleteResult;
}

async function callToolExpectingUserError(args: Record<string, unknown>) {
    const result = await callTool(args);
    expectSoftFailInvalidInput(result);
    expect(versionDeleteMock).not.toHaveBeenCalled();
    return result.content[0].text;
}

function expectNoOtherWrite() {
    expect(versionUpdateMock).not.toHaveBeenCalled();
    for (const [name, mock] of Object.entries(actorWriteMocks)) {
        expect(mock, name).not.toHaveBeenCalled();
    }
}

describe('delete-actor-version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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

    it('requires the actor and versionNumber, so it never picks a version itself', () => {
        const tool = deleteActorVersion as HelperTool;

        expect(tool.inputSchema.required).toEqual(['actor', 'versionNumber']);
        expect(tool.ajvValidate({ actor: 'john/my-actor' })).toBe(false);
        expect(tool.ajvValidate({ actor: 'john/my-actor', versionNumber: '' })).toBe(false);
        expect(tool.ajvValidate({ actor: 'john/my-actor', versionNumber: '0.2' })).toBe(true);
    });

    it.each(['0.1', '0.2'])(
        'deletes only version %s of the Actor it resolved, with one DELETE',
        async (versionNumber) => {
            const result = await callTool({ versionNumber });

            expectSchemaConformingStructuredContent(result, deleteActorVersionToolOutputSchema);
            // The Actor GET by the name given, then the DELETE by the Actor ID it returned.
            expect(actorMock.mock.calls).toEqual([['john/my-actor'], ['actor-1']]);
            expect(versionMock.mock.calls).toEqual([[versionNumber]]);
            expect(versionDeleteMock).toHaveBeenCalledTimes(1);
            expectNoOtherWrite();
            expect(result.structuredContent).toEqual({
                actorId: 'actor-1',
                fullName: 'john/my-actor',
                versionNumber,
                deleted: true,
            });
            expect(result.content[1].text).toBe(`Deleted version ${versionNumber} of john/my-actor.`);
        },
    );

    it('refuses a version the Actor does not have, which apify-client would report as deleted', async () => {
        expect(await callToolExpectingUserError({ versionNumber: '0.9' })).toBe(
            "Actor 'john/my-actor' has no version 0.9; available versions: 0.1, 0.2.",
        );
        expect(actorMock.mock.calls).toEqual([['john/my-actor']]);
        expect(versionMock).not.toHaveBeenCalled();
        expectNoOtherWrite();
    });

    it('reports a missing Actor', async () => {
        actorGetMock.mockResolvedValue(undefined);

        expect(await callToolExpectingUserError({ actor: 'my-actor' })).toBe(
            "Actor 'my-actor' not found. Give its ID or its full name, username/name; a name without the username is not enough.",
        );
        expect(actorMock.mock.calls).toEqual([['my-actor']]);
        expect(versionMock).not.toHaveBeenCalled();
        expectNoOtherWrite();
    });

    it("lets the platform's refusal to delete the last version through unchanged", async () => {
        actorGetMock.mockResolvedValue(mockActor({ versions: [{ versionNumber: '0.1', sourceType: 'SOURCE_FILES' }] }));
        const error = apiError(403, 'The Actor must have at least 1 versions', 'too-few-versions');
        versionDeleteMock.mockRejectedValue(error);

        await expect(callTool({ versionNumber: '0.1' })).rejects.toBe(error);
        // The tool leaves the check to the platform, and does nothing else after the refusal.
        expect(versionMock.mock.calls).toEqual([['0.1']]);
        expect(versionDeleteMock).toHaveBeenCalledTimes(1);
        expectNoOtherWrite();
    });

    it('sends nothing when the request is cancelled before the DELETE', async () => {
        const controller = new AbortController();
        actorGetMock.mockImplementation(async () => {
            controller.abort();
            return mockActor();
        });

        const result = await callTool({}, controller.signal);

        expect(result).toEqual({});
        expect(versionDeleteMock).not.toHaveBeenCalled();
        expectNoOtherWrite();
    });
});
