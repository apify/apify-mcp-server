import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import type { PreparedCall } from '../../src/mcp/tool_call_engine.js';
import { executeSyncToolCall, prepareToolCall } from '../../src/mcp/tool_call_engine.js';
import { updateActorEnvVars } from '../../src/tools/actors/update_actor_env_vars.js';
import { updateActorEnvVarsToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs, ToolEntry } from '../../src/types.js';
import { respondOk } from '../../src/utils/mcp.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const SECRET_VALUE = 'sk-live-very-secret';
const PLAIN_VALUE = 'plain-value-from-the-api';

const userGetMock = vi.fn();
const actorGetMock = vi.fn();
const envVarsListMock = vi.fn();
const envVarsCreateMock = vi.fn();
const envVarUpdateMock = vi.fn();
const envVarDeleteMock = vi.fn();
const envVarMock = vi.fn(() => ({ update: envVarUpdateMock, delete: envVarDeleteMock }));
const versionMock = vi.fn(() => ({
    envVars: () => ({ list: envVarsListMock, create: envVarsCreateMock }),
    envVar: envVarMock,
}));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock }));
const stubClient = {
    user: () => ({ get: userGetMock }),
    actor: actorMock,
} as unknown as InternalToolArgs['apifyClient'];

/** An Actor API document; `userId` is an internal field the tool must not leak. */
function mockActor(versionNumbers: string[] = ['0.1']) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        versions: versionNumbers.map((versionNumber) => ({ versionNumber, sourceType: 'SOURCE_FILES' })),
    };
}

/** What the list route returns: plain values in clear, secret values hidden. */
function mockEnvVarList(items: Record<string, unknown>[]) {
    return { total: items.length, items };
}

const EXISTING_ENV_VARS = [
    { name: 'PLAIN', value: PLAIN_VALUE, isSecret: false },
    { name: 'TOKEN', isSecret: true },
];

function apiError(status: number, message: string, type = 'some-error'): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext({ actor: 'my-actor', ...args }, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (updateActorEnvVars as HelperTool).call(context)) as TextToolResult;
};

/** Calls the tool expecting a soft-fail result and returns its first text block plus the raw result. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await (updateActorEnvVars as HelperTool).call(
        stubToolCallContext({ actor: 'my-actor', ...args }, stubClient),
    );
    expectSoftFailInvalidInput(result);
    const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };
    return { text: content[0].text, structuredContent };
};

const expectNoWrite = () => {
    expect(envVarsCreateMock).not.toHaveBeenCalled();
    expect(envVarUpdateMock).not.toHaveBeenCalled();
    expect(envVarDeleteMock).not.toHaveBeenCalled();
};

const expectNoApiCall = () => {
    expect(userGetMock).not.toHaveBeenCalled();
    expect(actorMock).not.toHaveBeenCalled();
};

describe('update-actor-env-vars', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userGetMock.mockResolvedValue({ username: 'john', id: 'user-secret' });
        actorGetMock.mockResolvedValue(mockActor());
        envVarsListMock.mockResolvedValue(mockEnvVarList(EXISTING_ENV_VARS));
        envVarsCreateMock.mockResolvedValue({});
        envVarUpdateMock.mockResolvedValue({});
        envVarDeleteMock.mockResolvedValue(undefined);
    });

    it('has the expected tool name', () => {
        expect(updateActorEnvVars.name).toBe(HELPER_TOOLS.ACTOR_ENV_VARS_UPDATE);
    });

    it('creates a missing variable, replaces an existing one and returns names and flags only', async () => {
        envVarsListMock.mockResolvedValueOnce(mockEnvVarList(EXISTING_ENV_VARS)).mockResolvedValueOnce(
            mockEnvVarList([
                { name: 'PLAIN', isSecret: true },
                { name: 'TOKEN', isSecret: true },
                { name: 'NEW', value: 'new-value', isSecret: false },
            ]),
        );

        const { content, structuredContent } = await callTool({
            set: [
                { name: 'NEW', value: 'new-value' },
                { name: 'PLAIN', value: SECRET_VALUE, isSecret: true },
            ],
        });

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        // The writes use the resolved Actor ID, not the user-supplied selector.
        expect(actorMock).toHaveBeenCalledWith('actor-1');
        expect(versionMock).toHaveBeenCalledWith('0.1');
        // isSecret defaults to false; the update is a full replacement, so it carries all three fields.
        expect(envVarsCreateMock).toHaveBeenCalledExactlyOnceWith({ name: 'NEW', value: 'new-value', isSecret: false });
        expect(envVarMock).toHaveBeenCalledExactlyOnceWith('PLAIN');
        expect(envVarUpdateMock).toHaveBeenCalledExactlyOnceWith({
            name: 'PLAIN',
            value: SECRET_VALUE,
            isSecret: true,
        });
        expect(envVarDeleteMock).not.toHaveBeenCalled();
        expect(structuredContent).toEqual({
            actorId: 'actor-1',
            fullName: 'john/my-actor',
            versionNumber: '0.1',
            created: ['NEW'],
            updated: ['PLAIN'],
            deleted: [],
            notPresent: [],
            envVars: [
                { name: 'PLAIN', isSecret: true },
                { name: 'TOKEN', isSecret: true },
                { name: 'NEW', isSecret: false },
            ],
        });
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content).toHaveLength(2);
        expect(content[1].text).toBe(
            'Updated the environment variables of john/my-actor version 0.1: 1 created, 1 updated, 0 deleted.\n' +
                `The change applies to runs of the next build. Rebuild version 0.1 with ${HELPER_TOOLS.ACTOR_BUILD}.`,
        );
    });

    it('writes one variable at a time', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const trackWrite = async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => {
                setTimeout(resolve, 1);
            });
            inFlight -= 1;
        };
        envVarsCreateMock.mockImplementation(trackWrite);
        envVarUpdateMock.mockImplementation(trackWrite);
        envVarDeleteMock.mockImplementation(trackWrite);

        await callTool({
            set: [
                { name: 'A', value: '1' },
                { name: 'PLAIN', value: '2' },
            ],
            delete: ['TOKEN'],
        });

        expect(maxInFlight).toBe(1);
    });

    it('deletes a present variable and reports an absent one as not present without calling delete for it', async () => {
        envVarsListMock
            .mockResolvedValueOnce(mockEnvVarList(EXISTING_ENV_VARS))
            .mockResolvedValueOnce(mockEnvVarList([{ name: 'PLAIN', value: PLAIN_VALUE, isSecret: false }]));

        const { content, structuredContent } = await callTool({ delete: ['TOKEN', 'MISSING'] });

        expect(envVarMock).toHaveBeenCalledExactlyOnceWith('TOKEN');
        expect(envVarDeleteMock).toHaveBeenCalledTimes(1);
        expect(structuredContent).toMatchObject({
            created: [],
            updated: [],
            deleted: ['TOKEN'],
            notPresent: ['MISSING'],
            envVars: [{ name: 'PLAIN', isSecret: false }],
        });
        expect(content[1].text).toBe(
            'Updated the environment variables of john/my-actor version 0.1: 0 created, 0 updated, 1 deleted. Not present, so not deleted: MISSING.\n' +
                `The change applies to runs of the next build. Rebuild version 0.1 with ${HELPER_TOOLS.ACTOR_BUILD}.`,
        );
    });

    it('asks for no rebuild when every name to delete is absent', async () => {
        const { content, structuredContent } = await callTool({ delete: ['MISSING'] });

        expectNoWrite();
        expect(structuredContent).toMatchObject({ deleted: [], notPresent: ['MISSING'] });
        expect(content[1].text).toBe(
            'Updated the environment variables of john/my-actor version 0.1: 0 created, 0 updated, 0 deleted. Not present, so not deleted: MISSING.\n' +
                'Nothing changed, so no rebuild is needed.',
        );
    });

    it('encodes a name in the variable route', async () => {
        envVarsListMock.mockResolvedValue(
            mockEnvVarList([
                { name: 'A#B', isSecret: true },
                { name: 'C/D', isSecret: false },
            ]),
        );

        await callTool({ set: [{ name: 'A#B', value: '1', isSecret: true }], delete: ['C/D'] });

        // Unencoded, 'A#B' would address variable 'A' and 'C/D' would address 'C~D'.
        expect(envVarMock.mock.calls).toEqual([['A%23B'], ['C%2FD']]);
        expect(envVarUpdateMock).toHaveBeenCalledExactlyOnceWith({ name: 'A#B', value: '1', isSecret: true });
        expect(envVarDeleteMock).toHaveBeenCalledTimes(1);
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        const result = await callTool({ set: [{ name: 'NEW', value: 'x' }], delete: ['TOKEN', 'MISSING'] });

        expect((updateActorEnvVars as HelperTool).outputSchema).toBe(updateActorEnvVarsToolOutputSchema);
        expectSchemaConformingStructuredContent(result, updateActorEnvVarsToolOutputSchema);
    });

    it('returns no value anywhere in the result, secret or plain', async () => {
        envVarsListMock.mockResolvedValue(
            mockEnvVarList([
                { name: 'PLAIN', value: PLAIN_VALUE, isSecret: false },
                { name: 'KEY', value: SECRET_VALUE, isSecret: true },
            ]),
        );

        const result = await callTool({ set: [{ name: 'KEY', value: SECRET_VALUE, isSecret: true }] });

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(SECRET_VALUE);
        expect(serialized).not.toContain(PLAIN_VALUE);
        expect(serialized).not.toContain('user-secret');
    });

    describe('input rules', () => {
        it('rejects a call with nothing to set or delete', async () => {
            const { text } = await callToolExpectingUserError({ set: [], delete: [] });

            expect(text).toBe('Pass at least one variable in set or one name in delete.');
            expectNoApiCall();
        });

        it('rejects a name that is both set and deleted', async () => {
            const { text } = await callToolExpectingUserError({ set: [{ name: 'A', value: '1' }], delete: ['A'] });

            expect(text).toBe("Environment variable 'A' is in both set and delete; keep it in one.");
            expectNoApiCall();
        });

        it('rejects a name set twice', async () => {
            const { text } = await callToolExpectingUserError({
                set: [
                    { name: 'A', value: '1' },
                    { name: 'A', value: '2' },
                ],
            });

            expect(text).toBe("Environment variable 'A' appears more than once in set.");
            expectNoApiCall();
        });

        it('rejects a name deleted twice', async () => {
            const { text } = await callToolExpectingUserError({ delete: ['A', 'A'] });

            expect(text).toBe("Environment variable 'A' appears more than once in delete.");
            expectNoApiCall();
        });

        // The AJV here drops `pattern`, so the platform's no-'=' rule is checked in code.
        it.each(['A=B', '=', 'KEY='])("rejects the name %s because it contains '='", async (name) => {
            const { text } = await callToolExpectingUserError({ set: [{ name, value: '1' }] });

            expect(text).toBe(`Environment variable name '${name}' must not contain '='.`);
            expectNoApiCall();
        });

        // Even encoded, '.' and '..' are path segments: a '..' delete would delete the version itself.
        it.each([
            ['set', { set: [{ name: '..', value: '1' }] }, '..'],
            ['delete', { delete: ['..'] }, '..'],
            ['delete', { delete: ['.'] }, '.'],
        ])('rejects a dot-segment name in %s', async (_field, args, name) => {
            const { text } = await callToolExpectingUserError(args);

            expect(text).toBe(
                `Environment variable name '${name}' cannot be used: the API cannot address a variable named '.' or '..'.`,
            );
            expectNoApiCall();
        });

        it('enforces the platform length limits through ajv validation', () => {
            const tool = updateActorEnvVars as HelperTool;
            const valid = { actor: 'my-actor', set: [{ name: 'A'.repeat(100), value: 'v'.repeat(50_000) }] };
            expect(tool.ajvValidate(valid)).toBe(true);
            expect(tool.ajvValidate({ actor: 'my-actor', set: [{ name: 'A'.repeat(101), value: '1' }] })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', set: [{ name: '', value: '1' }] })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', set: [{ name: 'A', value: 'v'.repeat(50_001) }] })).toBe(
                false,
            );
            expect(tool.ajvValidate({ actor: 'my-actor', delete: [''] })).toBe(false);
            expect(tool.ajvValidate({ actor: '', delete: ['A'] })).toBe(false);
        });

        it('lets isSecret be omitted in the input schema', () => {
            const tool = updateActorEnvVars as HelperTool;
            expect(tool.ajvValidate({ actor: 'my-actor', set: [{ name: 'A', value: '1' }] })).toBe(true);
            expect(tool.inputSchema.required).toEqual(['actor']);
        });
    });

    describe('variable limit', () => {
        const hundredNames = Array.from({ length: 100 }, (_, index) => ({ name: `VAR_${index}`, isSecret: true }));

        it('rejects a change that would leave the version with more than 100 variables', async () => {
            envVarsListMock.mockResolvedValue(mockEnvVarList(hundredNames.slice(0, 99)));

            const { text } = await callToolExpectingUserError({
                set: [
                    { name: 'NEW_1', value: '1' },
                    { name: 'NEW_2', value: '2' },
                    { name: 'VAR_0', value: 'replaced' },
                ],
            });

            expect(text).toBe('Version 0.1 would have 101 environment variables; the platform allows at most 100.');
            expectNoWrite();
        });

        it('allows exactly 100 variables when a delete makes room', async () => {
            envVarsListMock.mockResolvedValue(mockEnvVarList(hundredNames));

            const { structuredContent } = await callTool({ set: [{ name: 'NEW', value: '1' }], delete: ['VAR_0'] });

            expect(structuredContent).toMatchObject({ created: ['NEW'], deleted: ['VAR_0'] });
        });
    });

    describe('version resolution', () => {
        it('asks for versionNumber when the Actor has several versions', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));

            const { text } = await callToolExpectingUserError({ set: [{ name: 'A', value: '1' }] });

            expect(text).toBe('Specify versionNumber; this Actor has versions: 0.1, 0.2.');
            expect(envVarsListMock).not.toHaveBeenCalled();
            expectNoWrite();
        });

        it('changes the requested version when it exists', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));

            const { content } = await callTool({ versionNumber: '0.2', set: [{ name: 'A', value: '1' }] });

            expect(versionMock).toHaveBeenCalledWith('0.2');
            expect(content[1].text).toContain('version 0.2:');
        });

        it('lists the available versions when the requested one does not exist', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));

            const { text } = await callToolExpectingUserError({
                versionNumber: '1.0',
                set: [{ name: 'A', value: '1' }],
            });

            expect(text).toBe("Actor 'my-actor' has no version 1.0; available versions: 0.1, 0.2.");
            expectNoWrite();
        });

        it('returns an error when the Actor has no versions', async () => {
            actorGetMock.mockResolvedValue(mockActor([]));

            const { text } = await callToolExpectingUserError({ set: [{ name: 'A', value: '1' }] });

            expect(text).toBe("Actor 'my-actor' has no versions.");
            expectNoWrite();
        });
    });

    describe('Actor resolution', () => {
        it('returns a not-found error when the Actor does not exist', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const { text, structuredContent } = await callToolExpectingUserError({
                actor: 'john/missing',
                set: [{ name: 'A', value: '1' }],
            });

            expect(text).toBe("Actor 'john/missing' not found.");
            expect(structuredContent).toBeUndefined();
            expect(envVarsListMock).not.toHaveBeenCalled();
        });

        it('refuses an Actor of another account before any Actor lookup', async () => {
            const { text } = await callToolExpectingUserError({
                actor: 'jane/her-actor',
                set: [{ name: 'A', value: '1' }],
            });

            expect(text).toBe(
                "This tool works only with Actors of your own account (john); 'jane' names another account.",
            );
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('refuses an Actor ID that belongs to another account', async () => {
            const actorId = 'qGXMy0NAkWsIIb9LZ';
            actorGetMock
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({ ...mockActor(), id: actorId, username: 'jane' });

            const { text } = await callToolExpectingUserError({ actor: actorId, set: [{ name: 'A', value: '1' }] });

            expect(text).toBe(
                `This tool works only with Actors of your own account (john); Actor ${actorId} belongs to jane.`,
            );
            expectNoWrite();
        });
    });

    describe('API errors', () => {
        it('answers a denied write as an auth failure with the writes that landed before it', async () => {
            envVarUpdateMock.mockRejectedValue(
                apiError(403, 'Insufficient permissions for the Actor', 'insufficient-permissions'),
            );

            const result = await callTool({
                set: [
                    { name: 'NEW', value: '1' },
                    { name: 'PLAIN', value: '2' },
                ],
            });

            expect(result.content[0].text).toBe(
                'Insufficient permissions for the Actor (API error type: insufficient-permissions). ' +
                    'The resource may be private or your token may lack access. Before the failure this call created NEW.',
            );
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.AUTH,
                    failureHttpStatus: 403,
                }),
            );
        });

        it('answers a rejected token on the user lookup as an auth failure', async () => {
            userGetMock.mockRejectedValue(apiError(401, 'Authentication token is not valid', 'token-not-valid'));

            const result = await callTool({ set: [{ name: 'NEW', value: '1' }] });

            expect(result.content[0].text).toBe(
                'Authentication token is not valid (API error type: token-not-valid). ' +
                    'Authentication failed, check APIFY_TOKEN is set and valid.',
            );
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH, failureHttpStatus: 401 }),
            );
            expectNoWrite();
        });

        it('answers a duplicate create, which is a 403 too, as invalid input', async () => {
            envVarsCreateMock.mockRejectedValue(
                apiError(403, 'Environment variable with this name already exists', 'env-var-already-exists'),
            );

            const { text } = await callToolExpectingUserError({ set: [{ name: 'NEW', value: '1' }] });

            expect(text).toBe(
                'Environment variable with this name already exists (API error type: env-var-already-exists)',
            );
        });

        it('rethrows a server error', async () => {
            const serverError = apiError(500, 'Internal server error');
            envVarsCreateMock.mockRejectedValue(serverError);

            await expect(callTool({ set: [{ name: 'NEW', value: '1' }] })).rejects.toBe(serverError);
        });
    });

    describe('nextStep', () => {
        it('names build-actor when that tool is loaded', async () => {
            const { content } = await callTool({ set: [{ name: 'A', value: '1' }] }, [HELPER_TOOLS.ACTOR_BUILD]);

            expect(content[1].text).toContain(`Rebuild version 0.1 with ${HELPER_TOOLS.ACTOR_BUILD}.`);
        });

        it('names no tool when build-actor is not loaded', async () => {
            const { content } = await callTool({ set: [{ name: 'A', value: '1' }] }, [
                HELPER_TOOLS.ACTOR_ENV_VARS_UPDATE,
            ]);

            expect(content[1].text).toBe(
                'Updated the environment variables of john/my-actor version 0.1: 1 created, 0 updated, 0 deleted.\n' +
                    'The change applies to runs of the next build. Rebuild version 0.1 for the change to take effect.',
            );
            for (const toolName of Object.values(HELPER_TOOLS)) {
                expect(content[1].text).not.toContain(toolName);
            }
        });
    });

    describe('description', () => {
        it('names build-actor only when that tool is in the session', () => {
            const tool = updateActorEnvVars as HelperTool;
            expect(tool.description).toContain(HELPER_TOOLS.ACTOR_BUILD);
            expect(tool.buildDescription?.({ hasTool: () => false })).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });

        it('says where a per-task secret goes and to prefer secrets the platform holds', () => {
            const { description } = updateActorEnvVars;
            expect(description).toContain('Tasks have no environment variables');
            expect(description).toContain('marked isSecret');
            expect(description).toContain('Prefer secrets the platform already holds');
        });
    });

    it('declares the write as destructive and idempotent', () => {
        expect(updateActorEnvVars.annotations).toEqual({
            title: 'Update Actor environment variables',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect(updateActorEnvVars.paymentRequired).toBeUndefined();
    });

    describe('log redaction', () => {
        const { redactArgs } = updateActorEnvVars as HelperTool;

        afterEach(() => vi.restoreAllMocks());

        it('replaces every value in set and leaves the arguments untouched', () => {
            const args = {
                actor: 'my-actor',
                set: [
                    { name: 'A', value: SECRET_VALUE, isSecret: true },
                    { name: 'B', value: PLAIN_VALUE },
                ],
                delete: ['C'],
            };

            expect(redactArgs?.(args)).toEqual({
                actor: 'my-actor',
                set: [
                    { name: 'A', value: '[REDACTED]', isSecret: true },
                    { name: 'B', value: '[REDACTED]' },
                ],
                delete: ['C'],
            });
            expect(args.set[0].value).toBe(SECRET_VALUE);
        });

        // It runs before validation, so a malformed set may still carry a value, e.g. sent as a JSON string.
        it.each([
            ['a string', JSON.stringify([{ name: 'A', value: SECRET_VALUE }]), '[REDACTED]'],
            ['an object', { name: 'A', value: SECRET_VALUE }, '[REDACTED]'],
            ['an array with a non-object entry', [SECRET_VALUE, [SECRET_VALUE]], ['[REDACTED]', '[REDACTED]']],
        ])('replaces set whole when it is %s', (_label, set, expected) => {
            expect(redactArgs?.({ actor: 'my-actor', set })).toEqual({ actor: 'my-actor', set: expected });
        });

        it('keeps actor, versionNumber and delete as they are', () => {
            const args = { actor: 'my-actor', versionNumber: '0.1', delete: ['A'] };
            expect(redactArgs?.(args)).toEqual(args);
        });

        // AJV strips undeclared keys only from the tool's copy, so the logged copy must not keep them.
        it('replaces every undeclared key and every undeclared field of a set entry', () => {
            expect(
                redactArgs?.({
                    actor: 'my-actor',
                    envVars: [{ name: 'OPENAI_API_KEY', value: SECRET_VALUE, isSecret: true }],
                    set: [{ name: 'A', value: 'x', secretValue: SECRET_VALUE, isSecret: true }],
                }),
            ).toEqual({
                actor: 'my-actor',
                envVars: '[REDACTED]',
                set: [{ name: 'A', value: '[REDACTED]', isSecret: true }],
            });
        });

        /** Runs a real tools/call preparation and dispatch, with only the tool body stubbed out. */
        async function runToolCall(args: Record<string, unknown>) {
            const callMock = vi.fn(async () => respondOk('ok'));
            const tool = { ...updateActorEnvVars, call: callMock } as ToolEntry;
            const tools = new Map([[tool.name, tool]]);
            const prepared = await prepareToolCall({
                apifyToken: 'fake-token',
                name: tool.name,
                args,
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData: null,
                clientContext: undefined,
                tools,
            });
            if (!('tool' in prepared)) return { prepared, callMock };
            await executeSyncToolCall(prepared as PreparedCall, {
                apifyToken: 'fake-token',
                toolName: tool.name,
                mcpSessionId: 's1',
                progressToken: undefined,
                tools,
                signal: new AbortController().signal,
                sendNotification: vi.fn(),
                emitLog: vi.fn(),
            });
            return { prepared, callMock };
        }

        it('keeps the values out of the validation and the call logs while the tool gets them', async () => {
            const debugSpy = vi.spyOn(log, 'debug');
            const infoSpy = vi.spyOn(log, 'info');

            const { callMock } = await runToolCall({
                actor: 'my-actor',
                set: [{ name: 'API_KEY', value: SECRET_VALUE, isSecret: true }],
            });

            const validationLog = debugSpy.mock.calls.find(([message]) => message === 'Validate arguments for tool');
            const callLog = infoSpy.mock.calls.find(([message]) => message === 'Calling internal tool');
            expect(validationLog?.[1]).toMatchObject({ input: { set: [{ name: 'API_KEY', value: '[REDACTED]' }] } });
            expect(callLog?.[1]).toMatchObject({ input: { set: [{ name: 'API_KEY', value: '[REDACTED]' }] } });
            expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(SECRET_VALUE);
            expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(SECRET_VALUE);
            const [[toolArgs]] = callMock.mock.calls as unknown as [[InternalToolArgs]];
            expect(toolArgs.args).toEqual({
                actor: 'my-actor',
                set: [{ name: 'API_KEY', value: SECRET_VALUE, isSecret: true }],
            });
        });

        it('keeps a value sent under an undeclared key out of the validation and the call logs', async () => {
            const debugSpy = vi.spyOn(log, 'debug');
            const infoSpy = vi.spyOn(log, 'info');

            const { callMock } = await runToolCall({
                actor: 'my-actor',
                envVars: [{ name: 'OPENAI_API_KEY', value: SECRET_VALUE, isSecret: true }],
                set: [{ name: 'A', value: 'x', secretValue: SECRET_VALUE }],
            });

            expect(callMock).toHaveBeenCalledTimes(1);
            expect(infoSpy).toHaveBeenCalledWith('Calling internal tool', expect.anything());
            expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(SECRET_VALUE);
            expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(SECRET_VALUE);
        });

        it('keeps a value out of the validation log when the arguments fail validation', async () => {
            const debugSpy = vi.spyOn(log, 'debug');

            const { prepared, callMock } = await runToolCall({
                actor: 'my-actor',
                set: JSON.stringify([{ name: 'API_KEY', value: SECRET_VALUE }]),
            });

            expect('message' in prepared).toBe(true);
            expect(callMock).not.toHaveBeenCalled();
            expect(debugSpy).toHaveBeenCalledWith(
                'Validate arguments for tool',
                expect.objectContaining({ input: { actor: 'my-actor', set: '[REDACTED]' } }),
            );
            expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(SECRET_VALUE);
        });
    });
});
