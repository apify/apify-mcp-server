import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../src/const.js';
import { deleteActorEnvVar } from '../../src/tools/env_vars/delete_actor_env_var.js';
import { getCategoryTools } from '../../src/tools/index.js';
import { deleteActorEnvVarToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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
const envVarDeleteMock = vi.fn();
const envVarsMock = vi.fn(() => ({ list: envVarListMock }));
const envVarMock = vi.fn((_name: string) => ({ delete: envVarDeleteMock }));
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

type DeleteResult = TextToolResult & {
    structuredContent: Record<string, unknown>;
    toolTelemetry?: ToolTelemetrySnapshot;
};

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) =>
    (await (deleteActorEnvVar as HelperTool).call(
        stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient, { loadedToolNames }),
    )) as DeleteResult;

describe('delete-actor-env-var', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actorGetMock.mockResolvedValue(mockActor());
        envVarListMock.mockResolvedValue({
            total: 2,
            items: [
                { name: 'OPENAI_API_KEY', value: 'sk-secret', isSecret: true },
                { name: 'DEBUG', value: 'true', isSecret: false },
            ],
        });
        envVarDeleteMock.mockResolvedValue(undefined);
    });

    it('is a destructive tool in the env-vars category', () => {
        expect(deleteActorEnvVar.name).toBe(HELPER_TOOLS.ACTOR_ENV_VAR_DELETE);
        expect(deleteActorEnvVar.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(getCategoryTools()['env-vars']).toContain(deleteActorEnvVar);
    });

    it('deletes the variable through its own route and says runs need a rebuild', async () => {
        const result = await callTool({ name: 'DEBUG' });

        expect(versionMock).toHaveBeenCalledWith('0.1');
        expect(envVarMock).toHaveBeenCalledWith('DEBUG');
        expect(envVarDeleteMock).toHaveBeenCalledTimes(1);
        expect(result.structuredContent).toEqual({
            actorId: 'actor-1',
            fullName: 'john/my-actor',
            versionNumber: '0.1',
            name: 'DEBUG',
            deleted: true,
        });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content[1].text).toContain('after version 0.1 is rebuilt');
        expectSchemaConformingStructuredContent(result, deleteActorEnvVarToolOutputSchema);
    });

    it('never returns the value of a deleted secret', async () => {
        const result = await callTool({ name: 'OPENAI_API_KEY' });

        expect(envVarDeleteMock).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toContain('sk-secret');
    });

    it('soft-fails without a delete for a name the version does not have, and lists the names it has', async () => {
        const result = await callTool({ name: 'MISSING' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('OPENAI_API_KEY, DEBUG');
        expect(envVarDeleteMock).not.toHaveBeenCalled();
    });

    it.each(['.', '..'])('refuses the name %s before any API call', async (name) => {
        const result = await callTool({ name });

        expectSoftFailInvalidInput(result);
        expect(actorGetMock).not.toHaveBeenCalled();
        expect(envVarDeleteMock).not.toHaveBeenCalled();
    });

    it('reports a denied delete as an auth failure', async () => {
        envVarDeleteMock.mockRejectedValue(
            new ApifyApiError(
                {
                    status: 403,
                    data: { error: { type: 'insufficient-permissions', message: 'Insufficient permissions' } },
                    config: {
                        method: 'DELETE',
                        url: 'https://api.apify.com/v2/acts/actor-1/versions/0.1/env-vars/DEBUG',
                    },
                } as AxiosResponse,
                1,
            ),
        );

        const result = await callTool({ name: 'DEBUG' });

        expect(result.isError).toBe(true);
        expect(result.toolTelemetry).toMatchObject({ failureCategory: FAILURE_CATEGORY.AUTH });
    });
});
