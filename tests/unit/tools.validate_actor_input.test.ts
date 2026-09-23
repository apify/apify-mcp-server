import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { validateActorInput } from '../../src/tools/builds/validate_actor_input.js';
import { validateActorInputToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const validateInputMock = vi.fn();
const actorMock = vi.fn(() => ({ validateInput: validateInputMock }));
const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

const INPUT = { url: 'https://example.com', nested: { maxPages: 3 } };
const INVALID_INPUT_MESSAGE = 'Input is not valid: Field input.url is required, Field input.maxPages must be integer';
const RECHECK_STEP = 'then check again once that build has succeeded, passing its build number as build.';

function apiError(status: number, type: string, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext(args, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (validateActorInput as HelperTool).call(context)) as TextToolResult;
};

describe('validate-actor-input', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        validateInputMock.mockResolvedValue(true);
    });

    it('has the expected tool name', () => {
        expect(validateActorInput.name).toBe(HELPER_TOOLS.ACTOR_INPUT_VALIDATE);
    });

    it('checks against the build tagged latest when build is omitted', async () => {
        const { content, structuredContent, isError } = await callTool({ actor: 'john/my-actor', input: INPUT });

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        // No build is sent, so the API picks latest itself.
        expect(validateInputMock).toHaveBeenCalledWith(INPUT, undefined);
        expect(isError).not.toBe(true);
        expect(structuredContent).toEqual({ valid: true, actor: 'john/my-actor', build: 'latest' });
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content).toHaveLength(2);
        expect(content[1].text).toBe('The input is valid for build latest of Actor john/my-actor.');
    });

    it('forwards an explicit build to the API', async () => {
        const { content, structuredContent } = await callTool({ actor: 'actor-1', input: INPUT, build: '0.1.3' });

        expect(validateInputMock).toHaveBeenCalledWith(INPUT, { build: '0.1.3' });
        expect(structuredContent).toEqual({ valid: true, actor: 'actor-1', build: '0.1.3' });
        expect(content[1].text).toBe('The input is valid for build 0.1.3 of Actor actor-1.');
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        const result = await callTool({ actor: 'actor-1', input: INPUT });

        expect((validateActorInput as HelperTool).outputSchema).toBe(validateActorInputToolOutputSchema);
        expectSchemaConformingStructuredContent(result, validateActorInputToolOutputSchema);
    });

    describe('rejected input', () => {
        it.each([
            ['invalid-input', INVALID_INPUT_MESSAGE, 'Fix the input, or fix the input schema'],
            [
                'invalid-input-schema',
                'Input schema is not valid: Field schema.properties.url.type is required',
                // The schema did not compile, so the input was never checked and only the schema can be fixed.
                'Fix the input schema',
            ],
        ])('returns valid false with the API message for a 400 %s', async (type, message, fixStep) => {
            validateInputMock.mockRejectedValue(apiError(400, type, message));

            const result = await callTool({ actor: 'john/my-actor', input: INPUT, build: 'beta' });
            const { content, structuredContent, isError } = result;

            // The rejection is the answer to the call, not a tool failure.
            expect(isError).not.toBe(true);
            expect(structuredContent).toEqual({ valid: false, actor: 'john/my-actor', build: 'beta', message });
            expect(JSON.parse(content[0].text)).toEqual(structuredContent);
            expect(content).toHaveLength(2);
            expect(content[1].text).toBe(
                `${message}\n${fixStep} in .actor/input_schema.json, push the change with ${HELPER_TOOLS.ACTOR_PUSH} (it builds the version), ${RECHECK_STEP}`,
            );
            // push-actor already builds the pushed version, so a second build is not suggested.
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
            expectSchemaConformingStructuredContent(result, validateActorInputToolOutputSchema);
        });

        it('reports latest as the build when none was given', async () => {
            validateInputMock.mockRejectedValue(apiError(400, 'invalid-input', INVALID_INPUT_MESSAGE));

            const { structuredContent } = await callTool({ actor: 'actor-1', input: INPUT });

            expect(structuredContent).toMatchObject({ valid: false, build: 'latest' });
        });

        it('names no tool in the next step when push-actor and build-actor are not loaded', async () => {
            validateInputMock.mockRejectedValue(apiError(400, 'invalid-input', INVALID_INPUT_MESSAGE));

            const { content } = await callTool({ actor: 'actor-1', input: INPUT }, [HELPER_TOOLS.ACTOR_INPUT_VALIDATE]);

            expect(content[1].text).toBe(
                `${INVALID_INPUT_MESSAGE}\nFix the input, or fix the input schema in .actor/input_schema.json, push the change and build the Actor, ${RECHECK_STEP}`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_PUSH);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });

        it('names build-actor when push-actor is not loaded', async () => {
            validateInputMock.mockRejectedValue(apiError(400, 'invalid-input', INVALID_INPUT_MESSAGE));

            const { content } = await callTool({ actor: 'actor-1', input: INPUT }, [
                HELPER_TOOLS.ACTOR_INPUT_VALIDATE,
                HELPER_TOOLS.ACTOR_BUILD,
            ]);

            expect(content[1].text).toBe(
                `${INVALID_INPUT_MESSAGE}\nFix the input, or fix the input schema in .actor/input_schema.json, push the change and build the Actor with ${HELPER_TOOLS.ACTOR_BUILD}, ${RECHECK_STEP}`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_PUSH);
        });
    });

    describe('unusable build', () => {
        it.each([
            ['unknown-build-tag', 'Build with tag "beta" was not found. Has the Actor been built already?'],
            ['build-not-found', 'Build with number "0.1.99" was not found.'],
            ['build-outdated', 'This is an old build with unsupported fields. Please rebuild the Actor.'],
        ])('returns the API message and a build step for a 403 %s', async (type, message) => {
            validateInputMock.mockRejectedValue(apiError(403, type, message));

            const result = await (validateActorInput as HelperTool).call(
                stubToolCallContext({ actor: 'actor-1', input: INPUT, build: 'beta' }, stubClient),
            );
            const { content, structuredContent } = result as TextToolResult;

            expectSoftFailInvalidInput(result);
            expect(content.map((block) => block.text)).toEqual([
                message,
                `Build the Actor with ${HELPER_TOOLS.ACTOR_BUILD}, or pass a build that finished successfully, then check again.`,
            ]);
            expect(structuredContent).toBeUndefined();
        });

        it('names no tool when build-actor is not loaded', async () => {
            validateInputMock.mockRejectedValue(
                apiError(
                    403,
                    'unknown-build-tag',
                    'Build with tag "latest" was not found. Has the Actor been built already?',
                ),
            );

            const { content } = await callTool({ actor: 'actor-1', input: INPUT }, [HELPER_TOOLS.ACTOR_INPUT_VALIDATE]);

            expect(content[1].text).toBe(
                'Build the Actor, or pass a build that finished successfully, then check again.',
            );
            expect(content.map((block) => block.text).join('\n')).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });

        // invalid-build also covers a build that is still running, so the step is to wait, not to build again.
        it('returns the API message and a wait step for a 403 invalid-build', async () => {
            validateInputMock.mockRejectedValue(
                apiError(403, 'invalid-build', 'The build has not finished or was not successful.'),
            );

            const result = await (validateActorInput as HelperTool).call(
                stubToolCallContext({ actor: 'actor-1', input: INPUT, build: '0.1.4' }, stubClient),
            );
            const { content, structuredContent } = result as TextToolResult;

            expectSoftFailInvalidInput(result);
            expect(content.map((block) => block.text)).toEqual([
                'The build has not finished or was not successful.',
                `Wait for the build to finish with ${HELPER_TOOLS.ACTOR_BUILD_GET}, or pass a build that succeeded, then check again.`,
            ]);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
            expect(structuredContent).toBeUndefined();
        });

        it('names no tool in the invalid-build wait step when get-actor-build is not loaded', async () => {
            validateInputMock.mockRejectedValue(
                apiError(403, 'invalid-build', 'The build has not finished or was not successful.'),
            );

            const { content } = await callTool({ actor: 'actor-1', input: INPUT, build: '0.1.4' }, [
                HELPER_TOOLS.ACTOR_INPUT_VALIDATE,
                HELPER_TOOLS.ACTOR_BUILD,
            ]);

            expect(content[1].text).toBe(
                'Wait for the build to finish, or pass a build that succeeded, then check again.',
            );
            expect(content.map((block) => block.text).join('\n')).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });
    });

    it('returns a not-found error when the Actor does not exist', async () => {
        validateInputMock.mockRejectedValue(apiError(404, 'record-not-found', 'Actor was not found'));

        const result = await (validateActorInput as HelperTool).call(
            stubToolCallContext({ actor: 'john/missing', input: INPUT }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(actorMock).toHaveBeenCalledWith('john/missing');
        expect(content).toHaveLength(1);
        expect(content[0].text).toBe("Actor 'john/missing' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it.each([
        ['a 403 that is not a build problem', apiError(403, 'insufficient-permissions', 'Insufficient permissions.')],
        ['a 400 of another type', apiError(400, 'invalid-request', 'Invalid request')],
        ['a server error', apiError(500, 'internal-server-error', 'Internal server error')],
        ['a non-API error', new TypeError('boom')],
    ])('rethrows %s', async (_label, error) => {
        validateInputMock.mockRejectedValue(error);

        await expect(callTool({ actor: 'actor-1', input: INPUT })).rejects.toBe(error);
    });

    describe('input validation', () => {
        it('rejects an empty actor, a missing or non-object input and an empty build via ajv validation', () => {
            const tool = validateActorInput as HelperTool;
            expect(tool.ajvValidate({ actor: '', input: INPUT })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1' })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', input: [] })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', input: 'url=https://example.com' })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', input: INPUT, build: '' })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', input: {}, build: 'latest' })).toBe(true);
        });

        // The shared AJV strips unknown keys; the input's own fields must survive it untouched.
        it('keeps every input field through ajv validation', () => {
            const args = { actor: 'actor-1', input: structuredClone(INPUT) };

            expect((validateActorInput as HelperTool).ajvValidate(args)).toBe(true);
            expect(args.input).toEqual(INPUT);
        });

        it('requires actor and input in the input schema', () => {
            expect(validateActorInput.inputSchema.required).toEqual(['actor', 'input']);
        });

        it('says in the build field that an omitted build means latest, not the default build', () => {
            const { build } = validateActorInput.inputSchema.properties as Record<string, { description: string }>;
            expect(build.description).toContain(
                "If omitted, the build tagged latest is used, not the Actor's default build.",
            );
        });
    });

    it('is annotated read-only, non-destructive, idempotent and closed-world, with no payment', () => {
        expect(validateActorInput.annotations).toEqual({
            title: 'Validate Actor input',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect((validateActorInput as HelperTool).paymentRequired).toBeUndefined();
    });

    describe('description', () => {
        it('names push-actor, or build-actor without it, only when they are in the session', () => {
            const tool = validateActorInput as HelperTool;
            expect(tool.description).toContain(
                `push the change with ${HELPER_TOOLS.ACTOR_PUSH} (it builds the version), ${RECHECK_STEP}`,
            );
            expect(tool.description).not.toContain(HELPER_TOOLS.ACTOR_BUILD);

            const withBuildOnly = tool.buildDescription?.(
                only(HELPER_TOOLS.ACTOR_INPUT_VALIDATE, HELPER_TOOLS.ACTOR_BUILD),
            );
            expect(withBuildOnly).toContain(
                `push the change and build the Actor with ${HELPER_TOOLS.ACTOR_BUILD}, ${RECHECK_STEP}`,
            );

            const alone = tool.buildDescription?.(only(HELPER_TOOLS.ACTOR_INPUT_VALIDATE));
            expect(alone).toContain(`push the change and build the Actor, ${RECHECK_STEP}`);
            expect(alone).not.toContain(HELPER_TOOLS.ACTOR_PUSH);
            expect(alone).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });
    });
});
