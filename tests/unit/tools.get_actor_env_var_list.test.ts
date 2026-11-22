import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { getActorEnvVarList } from '../../src/tools/env_vars/get_actor_env_var_list.js';
import { getCategoryTools, toolCategoriesEnabledByDefault } from '../../src/tools/index.js';
import { getActorEnvVarListToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const actorGetMock = vi.fn();
const envVarListMock = vi.fn();
const envVarsMock = vi.fn(() => ({ list: envVarListMock }));
const versionMock = vi.fn(() => ({ envVars: envVarsMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock }));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

/** Values the tool must never return: a secret's value and its hash. */
const SECRET_VALUE = 'sk-secret-value';
const SECRET_HASH = 'secret-value-hash';

/** The env-vars list as the API returns it: a secret with its hash, a plain variable, and one with no value. */
function mockEnvVarItems() {
    return [
        { name: 'OPENAI_API_KEY', value: SECRET_VALUE, valueHash: SECRET_HASH, isSecret: true },
        { name: 'MODE', value: 'production', valueHash: 'mode-hash', isSecret: false },
        { name: 'EMPTY' },
    ];
}

function mockActor(versionNumbers: string[] = ['0.1']) {
    return {
        id: 'actor-1',
        name: 'my-actor',
        username: 'john',
        versions: versionNumbers.map((versionNumber) => ({ versionNumber, sourceType: 'SOURCE_FILES' })),
    };
}

type EnvVarListResult = TextToolResult & {
    structuredContent: {
        envVars: { name: string; isSecret: boolean; value?: string }[];
        omittedValueNames?: string[];
        [key: string]: unknown;
    };
    toolTelemetry?: ToolTelemetrySnapshot;
};

const callTool = async (args: Record<string, unknown>) =>
    (await (getActorEnvVarList as HelperTool).call(
        stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient),
    )) as EnvVarListResult;

describe('get-actor-env-var-list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actorGetMock.mockResolvedValue(mockActor());
        envVarListMock.mockResolvedValue({ total: 3, items: mockEnvVarItems() });
    });

    it('is a read-only tool in the env-vars category, which is not enabled by default', () => {
        expect(getActorEnvVarList.name).toBe(HELPER_TOOLS.ACTOR_ENV_VAR_LIST_GET);
        expect(getActorEnvVarList.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(getCategoryTools()['env-vars']).toContain(getActorEnvVarList);
        expect(toolCategoriesEnabledByDefault).not.toContain('env-vars');
    });

    it("returns each variable's name and isSecret, and the value of plain ones only", async () => {
        const result = await callTool({});

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        expect(actorMock).toHaveBeenCalledWith('actor-1');
        expect(versionMock).toHaveBeenCalledWith('0.1');
        expect(result.structuredContent).toEqual({
            actorId: 'actor-1',
            fullName: 'john/my-actor',
            versionNumber: '0.1',
            envVars: [
                { name: 'OPENAI_API_KEY', isSecret: true },
                { name: 'MODE', isSecret: false, value: 'production' },
                { name: 'EMPTY', isSecret: false },
            ],
        });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content[1].text).toBe('Version 0.1 of john/my-actor has 3 environment variables, 1 secret.');
        expectSchemaConformingStructuredContent(result, getActorEnvVarListToolOutputSchema);
        const serialized = JSON.stringify(result);
        for (const leaked of [SECRET_VALUE, SECRET_HASH, 'mode-hash']) {
            expect(serialized).not.toContain(leaked);
        }
    });

    it('reads the requested version of an Actor with several', async () => {
        actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));

        await callTool({ versionNumber: '0.2' });

        expect(versionMock).toHaveBeenCalledWith('0.2');
    });

    it.each([
        {
            outcome: 'several versions and no versionNumber',
            args: {},
            setup: () => actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2'])),
        },
        { outcome: 'a version the Actor does not have', args: { versionNumber: '9.9' }, setup: () => {} },
        { outcome: 'a missing Actor', args: {}, setup: () => actorGetMock.mockResolvedValue(undefined) },
    ])('soft-fails without reading variables for $outcome', async ({ args, setup }) => {
        setup();

        const result = await callTool(args);

        expectSoftFailInvalidInput(result);
        expect(envVarListMock).not.toHaveBeenCalled();
    });

    it('leaves out the plain values over the inline limit, names them, and keeps the values after them that fit', async () => {
        const half = 'x'.repeat(MAX_INLINE_BYTES / 2);
        envVarListMock.mockResolvedValue({
            total: 4,
            items: [
                { name: 'FIRST', value: half, isSecret: false },
                { name: 'TOO_BIG', value: `${half}x`, isSecret: false },
                { name: 'SECOND', value: half, isSecret: false },
                { name: 'LAST', value: 'small', isSecret: false },
            ],
        });

        const result = await callTool({});

        expect(result.structuredContent.envVars).toEqual([
            { name: 'FIRST', isSecret: false, value: half },
            { name: 'TOO_BIG', isSecret: false },
            { name: 'SECOND', isSecret: false, value: half },
            { name: 'LAST', isSecret: false },
        ]);
        expect(result.structuredContent.omittedValueNames).toEqual(['TOO_BIG', 'LAST']);
        expect(result.content[1].text).toContain('TOO_BIG, LAST');
        expectSchemaConformingStructuredContent(result, getActorEnvVarListToolOutputSchema);
    });

    it('rethrows an API error of the variable list for the tool-call engine to report', async () => {
        const error = new ApifyApiError(
            {
                status: 403,
                data: { error: { type: 'insufficient-permissions', message: 'Insufficient permissions' } },
                config: { method: 'GET', url: 'https://api.apify.com/v2/acts/actor-1/versions/0.1/env-vars' },
            } as AxiosResponse,
            1,
        );
        envVarListMock.mockRejectedValue(error);

        await expect(callTool({})).rejects.toBe(error);
    });
});
