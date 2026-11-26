import type { InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { ApifyClient, getApifyAPIBaseUrl } from '../../src/apify_client.js';
import { HELPER_TOOLS } from '../../src/const.js';
import type { ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import {
    appendUsageNotice,
    getUsageNoticeOptions,
    MCP_CLIENT_NAME_MAX_LENGTH,
    prepareUsageCheck,
    type UsageCheck,
} from '../../src/utils/usage_notice.js';
import { makeActorTool, makeArgsRecorderTool } from './helpers/mcp_server.js';
import { mockApifyClient } from './helpers/tool_context.js';

const NOTICE =
    '**Apify account notice:** This account has used $4.10 of the $5.00 monthly usage included in the Free plan.';
const TOOL_RESULT = { content: [{ type: 'text', text: 'Run finished.' }], structuredContent: { runId: 'run-1' } };

/** A usage check whose API answers with `request`; a fresh token each time, as "no notice" answers are cached by token. */
function makeCheck(request: () => Promise<unknown>, signal = new AbortController().signal): UsageCheck {
    return {
        mcpClientName: 'claude-code',
        apifyToken: `token-${Math.random()}`,
        apifyClient: mockApifyClient({ httpClient: { axios: { request: vi.fn(request) } } }),
        toolName: 'apify--instagram-scraper',
        signal,
    };
}

function requestOf(check: UsageCheck) {
    return (check.apifyClient.httpClient.axios.request as ReturnType<typeof vi.fn>).mock;
}

describe('when the server asks for the usage notice', () => {
    it('asks with telemetry on', () => {
        expect(getUsageNoticeOptions({ telemetryEnabled: true }, undefined)).toEqual({ mcpClientName: '' });
    });

    it('does not ask with telemetry off, as the API logs the experiment for every notice it decides', () => {
        expect(getUsageNoticeOptions({ telemetryEnabled: false }, undefined)).toBeUndefined();
    });

    it('cuts a client name longer than the API accepts', () => {
        const clientInfo = { name: 'c'.repeat(MCP_CLIENT_NAME_MAX_LENGTH + 1), version: '1.0.0' };

        const options = getUsageNoticeOptions({ telemetryEnabled: true }, { clientInfo });

        expect(options?.mcpClientName).toHaveLength(MCP_CLIENT_NAME_MAX_LENGTH);
    });
});

describe('which tool calls ask for the usage notice', () => {
    const base = {
        options: { mcpClientName: 'claude-code' },
        apifyToken: 'token',
        apifyClient: mockApifyClient(),
        signal: new AbortController().signal,
    };

    it.each([
        ['an Actor tool', makeActorTool()],
        ['call-actor', makeArgsRecorderTool(HELPER_TOOLS.ACTOR_CALL).tool],
    ])('asks after %s', (_label, tool) => {
        expect(prepareUsageCheck({ ...base, tool })).not.toBeNull();
    });

    it.each([
        ['an internal tool that runs no Actor', makeArgsRecorderTool(HELPER_TOOLS.DATASET_GET_ITEMS).tool],
        ['send-server-actor-request', makeArgsRecorderTool(HELPER_TOOLS.ACTOR_SERVER_REQUEST).tool],
        ['an Actor server tool', { ...makeActorTool(), type: TOOL_TYPE.ACTOR_SERVER } as ToolEntry],
    ])('skips %s', (_label, tool) => {
        expect(prepareUsageCheck({ ...base, tool })).toBeNull();
    });

    it('skips a call without a token', () => {
        expect(prepareUsageCheck({ ...base, tool: makeActorTool(), apifyToken: undefined })).toBeNull();
    });

    it('skips every call with telemetry off', () => {
        expect(prepareUsageCheck({ ...base, tool: makeActorTool(), options: undefined })).toBeNull();
    });
});

describe('usage notice on a tool result', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('appends the notice the API returns as the last item', async () => {
        // The real client, so its interceptors serialize the body and parse the JSON answer; only the transport is fake.
        const apifyClient = new ApifyClient({ token: 'test-token', maxRetries: 0 });
        const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
            config,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            data: Buffer.from(JSON.stringify({ data: { notice: NOTICE } })),
        }));
        apifyClient.httpClient.axios.defaults.adapter = adapter;
        const check = { ...makeCheck(async () => undefined), apifyClient };

        const result = await appendUsageNotice(TOOL_RESULT, check);

        expect(result.content).toEqual([...TOOL_RESULT.content, { type: 'text', text: NOTICE }]);
        expect(result.structuredContent).toBe(TOOL_RESULT.structuredContent);
        const [config] = adapter.mock.calls[0];
        expect(config).toMatchObject({ url: `${getApifyAPIBaseUrl()}/unstable/users/me/usage-notice`, method: 'post' });
        expect(JSON.parse(config.data)).toEqual({ toolName: check.toolName, mcpClientName: check.mcpClientName });
    });

    it('does not ask the same token again for a while after no notice', async () => {
        const check = makeCheck(async () => ({ status: 200, data: { data: { notice: null } } }));

        expect(await appendUsageNotice(TOOL_RESULT, check)).toBe(TOOL_RESULT);
        await appendUsageNotice(TOOL_RESULT, check);

        expect(requestOf(check).calls).toHaveLength(1);
    });

    it('treats a refusal like no notice, so a scoped token is not asked on every call', async () => {
        const check = makeCheck(async () => ({ status: 403, data: { error: { type: 'insufficient-permissions' } } }));

        expect(await appendUsageNotice(TOOL_RESULT, check)).toBe(TOOL_RESULT);
        await appendUsageNotice(TOOL_RESULT, check);

        expect(requestOf(check).calls).toHaveLength(1);
    });

    it('returns the result unchanged when the request fails, and asks again next time', async () => {
        vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const check = makeCheck(async () => {
            throw new Error('timeout of 2000ms exceeded');
        });

        expect(await appendUsageNotice(TOOL_RESULT, check)).toBe(TOOL_RESULT);
        await appendUsageNotice(TOOL_RESULT, check);

        expect(requestOf(check).calls).toHaveLength(2);
    });

    it('does not ask for a result without text', async () => {
        // The SDK adds non-object structured content as text only when the result has no text item.
        const check = makeCheck(async () => ({ status: 200, data: { data: { notice: NOTICE } } }));
        const result = { content: [], structuredContent: ['item-1'] };

        expect(await appendUsageNotice(result, check)).toBe(result);
        expect(requestOf(check).calls).toHaveLength(0);
    });

    it('does not ask for a cancelled call, so the notice is not used up', async () => {
        const controller = new AbortController();
        controller.abort();
        const check = makeCheck(async () => ({ status: 200, data: { data: { notice: NOTICE } } }), controller.signal);

        expect(await appendUsageNotice(TOOL_RESULT, check)).toBe(TOOL_RESULT);
        expect(requestOf(check).calls).toHaveLength(0);
    });
});
