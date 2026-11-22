import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { prepareToolCallContext } from '../../src/mcp/tool_call_context.js';
import { ENV_VARS_MAX_COUNT } from '../../src/tools/env_vars/env_var_helpers.js';
import { setActorEnvVar } from '../../src/tools/env_vars/set_actor_env_var.js';
import { getCategoryTools } from '../../src/tools/index.js';
import { setActorEnvVarToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

/** The value the tool must never return or log. */
const SECRET_VALUE = 'sk-live-4f2a9c';

const actorGetMock = vi.fn();
const envVarListMock = vi.fn();
const envVarCreateMock = vi.fn();
const envVarUpdateMock = vi.fn();
const envVarsMock = vi.fn(() => ({ list: envVarListMock, create: envVarCreateMock }));
const envVarMock = vi.fn((_name: string) => ({ update: envVarUpdateMock }));
const versionMock = vi.fn(() => ({ envVars: envVarsMock, envVar: envVarMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock }));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

function mockActor(versionNumbers: string[] = ['0.1']) {
    return {
        id: 'actor-1',
        name: 'my-actor',
        username: 'john',
        versions: versionNumbers.map((versionNumber) => ({ versionNumber, sourceType: 'SOURCE_FILES' })),
    };
}

/** The env-vars list as the API returns it: an existing secret and a plain variable. */
function mockEnvVarItems() {
    return [
        { name: 'OPENAI_API_KEY', value: 'sk-old', valueHash: 'old-hash', isSecret: true },
        { name: 'MODE', value: 'production', valueHash: 'mode-hash', isSecret: false },
    ];
}

function mockApiError(status: number, type: string, message: string, attempt = 1) {
    return new ApifyApiError(
        {
            status,
            data: { error: { type, message } },
            config: { method: 'POST', url: 'https://api.apify.com/v2/acts/actor-1/versions/0.1/env-vars' },
        } as AxiosResponse,
        attempt,
    );
}

type SetResult = TextToolResult & {
    structuredContent: Record<string, unknown>;
    toolTelemetry?: ToolTelemetrySnapshot;
};

const callTool = async (
    args: Record<string, unknown>,
    context: { loadedToolNames?: readonly string[]; signal?: AbortSignal } = {},
) => {
    const toolArgs = stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient, context);
    return (await (setActorEnvVar as HelperTool).call({
        ...toolArgs,
        signal: context.signal ?? toolArgs.signal,
    })) as SetResult;
};

function expectNoWrite() {
    expect(envVarCreateMock).not.toHaveBeenCalled();
    expect(envVarUpdateMock).not.toHaveBeenCalled();
}

describe('set-actor-env-var', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actorGetMock.mockResolvedValue(mockActor());
        envVarListMock.mockResolvedValue({ total: 2, items: mockEnvVarItems() });
        envVarCreateMock.mockImplementation(async (envVar: unknown) => envVar);
        envVarUpdateMock.mockImplementation(async (envVar: unknown) => envVar);
    });

    it('is a destructive write tool in the env-vars category', () => {
        expect(setActorEnvVar.name).toBe(HELPER_TOOLS.ACTOR_ENV_VAR_SET);
        expect(setActorEnvVar.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(getCategoryTools()['env-vars']).toContain(setActorEnvVar);
    });

    it('names build-actor in its description only when the session has it', () => {
        const { buildDescription } = setActorEnvVar as HelperTool & {
            buildDescription: NonNullable<HelperTool['buildDescription']>;
        };

        expect(buildDescription(only(HELPER_TOOLS.ACTOR_BUILD))).toContain(HELPER_TOOLS.ACTOR_BUILD);
        expect(buildDescription(only())).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
    });

    describe('create', () => {
        it('creates a new variable through the collection, plain when isSecret is omitted', async () => {
            const result = await callTool({ name: 'DEBUG', value: 'true' });

            expect(versionMock).toHaveBeenCalledWith('0.1');
            expect(envVarCreateMock).toHaveBeenCalledWith({ name: 'DEBUG', value: 'true', isSecret: false });
            expect(envVarUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent).toEqual({
                actorId: 'actor-1',
                fullName: 'john/my-actor',
                versionNumber: '0.1',
                name: 'DEBUG',
                isSecret: false,
                created: true,
            });
            expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
            expectSchemaConformingStructuredContent(result, setActorEnvVarToolOutputSchema);
        });

        it('creates a secret and never returns its value', async () => {
            const result = await callTool({ name: 'ANTHROPIC_API_KEY', value: SECRET_VALUE, isSecret: true });

            expect(envVarCreateMock).toHaveBeenCalledWith({
                name: 'ANTHROPIC_API_KEY',
                value: SECRET_VALUE,
                isSecret: true,
            });
            expect(result.structuredContent).toMatchObject({ isSecret: true, created: true });
            expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
        });

        it('refuses a create on a version at the variable limit before any write', async () => {
            const items = Array.from({ length: ENV_VARS_MAX_COUNT }, (_, index) => ({ name: `VAR_${index}` }));
            envVarListMock.mockResolvedValue({ total: items.length, items });

            const result = await callTool({ name: 'DEBUG', value: 'true' });

            expectSoftFailInvalidInput(result);
            expectNoWrite();
        });
    });

    describe('update', () => {
        it('updates an existing variable through its own route and keeps it secret when isSecret is omitted', async () => {
            const result = await callTool({ name: 'OPENAI_API_KEY', value: SECRET_VALUE });

            expect(envVarMock).toHaveBeenCalledWith('OPENAI_API_KEY');
            expect(envVarUpdateMock).toHaveBeenCalledWith({
                name: 'OPENAI_API_KEY',
                value: SECRET_VALUE,
                isSecret: true,
            });
            expect(envVarCreateMock).not.toHaveBeenCalled();
            expect(result.structuredContent).toMatchObject({ isSecret: true, created: false });
            expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
        });

        it('lets an explicit isSecret change a variable', async () => {
            await callTool({ name: 'MODE', value: 'staging', isSecret: true });

            expect(envVarUpdateMock).toHaveBeenCalledWith({ name: 'MODE', value: 'staging', isSecret: true });
        });

        it('updates a variable on a version over the limit', async () => {
            const items = [
                ...mockEnvVarItems(),
                ...Array.from({ length: ENV_VARS_MAX_COUNT }, (_, index) => ({ name: `VAR_${index}` })),
            ];
            envVarListMock.mockResolvedValue({ total: items.length, items });

            const result = await callTool({ name: 'MODE', value: 'staging' });

            expect(result.isError).not.toBe(true);
            expect(envVarUpdateMock).toHaveBeenCalled();
        });

        it('encodes the name in the route', async () => {
            envVarListMock.mockResolvedValue({ total: 1, items: [{ name: 'A/B?C', value: 'x', isSecret: false }] });

            await callTool({ name: 'A/B?C', value: 'y' });

            expect(envVarMock).toHaveBeenCalledWith('A%2FB%3FC');
        });
    });

    it('says runs see the change after a rebuild, naming build-actor only when it is loaded', async () => {
        const withBuild = await callTool({ name: 'DEBUG', value: 'true' });
        const withoutBuild = await callTool(
            { name: 'DEBUG', value: 'true' },
            { loadedToolNames: [HELPER_TOOLS.ACTOR_ENV_VAR_SET] },
        );

        expect(withBuild.content[1].text).toContain('after version 0.1 is rebuilt');
        expect(withBuild.content[1].text).toContain(HELPER_TOOLS.ACTOR_BUILD);
        expect(withoutBuild.content[1].text).toContain('after version 0.1 is rebuilt');
        expect(withoutBuild.content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
    });

    it.each(['.', '..'])('refuses the name %s before any API call', async (name) => {
        const result = await callTool({ name, value: 'x' });

        expectSoftFailInvalidInput(result);
        expect(actorGetMock).not.toHaveBeenCalled();
        expectNoWrite();
    });

    it('soft-fails without a write for a version the Actor does not have', async () => {
        const result = await callTool({ name: 'DEBUG', value: 'true', versionNumber: '9.9' });

        expectSoftFailInvalidInput(result);
        expect(envVarListMock).not.toHaveBeenCalled();
        expectNoWrite();
    });

    it('writes nothing when the call is cancelled before the write', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await callTool({ name: 'DEBUG', value: 'true' }, { signal: controller.signal });

        expect(result).toEqual({});
        expectNoWrite();
    });

    describe('API errors', () => {
        it('reports a denied write as an auth failure', async () => {
            envVarCreateMock.mockRejectedValue(
                mockApiError(403, 'insufficient-permissions', 'Insufficient permissions for the Actor'),
            );

            const result = await callTool({ name: 'DEBUG', value: 'true' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('insufficient-permissions');
            expect(result.toolTelemetry).toMatchObject({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.AUTH,
            });
        });

        it('reports a duplicate create, which the API answers with 403, as invalid input', async () => {
            envVarCreateMock.mockRejectedValue(mockApiError(403, 'env-var-already-exists', 'Already exists'));

            const result = await callTool({ name: 'DEBUG', value: 'true' });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).not.toContain('retried');
        });

        it('says a duplicate refused on a retried attempt may be this call’s own earlier attempt', async () => {
            envVarCreateMock.mockRejectedValue(mockApiError(403, 'env-var-already-exists', 'Already exists', 2));

            const result = await callTool({ name: 'DEBUG', value: 'true' });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toContain('an earlier attempt of this call may have created the variable');
        });

        it('leaves out an API message that contains the value', async () => {
            envVarCreateMock.mockRejectedValue(
                mockApiError(400, 'invalid-value', `Value "${SECRET_VALUE}" is not allowed`),
            );

            const result = await callTool({ name: 'DEBUG', value: SECRET_VALUE });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toContain('invalid-value');
            expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
        });

        it('rethrows any other error without the value in its message', async () => {
            envVarCreateMock.mockRejectedValue(new Error(`socket hang up while sending ${SECRET_VALUE}`));

            const error: unknown = await callTool({ name: 'DEBUG', value: SECRET_VALUE }).catch((caught) => caught);

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).not.toContain(SECRET_VALUE);
        });
    });

    describe('logged arguments', () => {
        it('log every argument but the value, and drop undeclared keys', () => {
            const args = {
                actor: 'john/my-actor',
                versionNumber: '0.1',
                name: 'OPENAI_API_KEY',
                value: SECRET_VALUE,
                isSecret: true,
                secret: SECRET_VALUE,
            };

            const { toolArgsRedacted, toolArgs } = prepareToolCallContext({
                tool: setActorEnvVar,
                args,
                apifyToken: 'test-token',
            });

            expect(toolArgsRedacted).toEqual({
                actor: 'john/my-actor',
                versionNumber: '0.1',
                name: 'OPENAI_API_KEY',
                value: '[REDACTED]',
                isSecret: true,
            });
            expect(toolArgs).toMatchObject({ value: SECRET_VALUE });
        });
    });
});
