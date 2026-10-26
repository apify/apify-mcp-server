import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, MAX_INLINE_BYTES, TOOL_STATUS } from '../../src/const.js';
import { buildToolCallErrorResult, TOOL_CALL_ERROR_KIND } from '../../src/mcp/tool_call_error_mapper.js';
import { wrapChatGptOutputTool } from '../../src/tools/chatgpt_output_tools.js';
import { getActorRunLog } from '../../src/tools/runs/get_actor_run_log.js';
import { getDatasetItems } from '../../src/tools/storage/get_dataset_items.js';
import { getKeyValueStoreRecord } from '../../src/tools/storage/get_key_value_store_record.js';
import type { ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { toPlainError } from '../../src/utils/logging.js';
import { makePaymentRequiredError, makePermissionApprovalError } from './helpers/mcp_server.js';
import {
    expectSchemaConformingStructuredContent,
    mockApifyClient,
    stubToolCallContext,
} from './helpers/tool_context.js';

function wrapped(tool: ToolEntry) {
    const result = wrapChatGptOutputTool(tool);
    if (result.type !== TOOL_TYPE.INTERNAL) throw new Error('Expected an internal tool');
    return result;
}

describe('submission retrieval limits', () => {
    it('bounds dataset calls and rejects extra arguments without calling the API', async () => {
        const listItems = vi.fn().mockResolvedValue({ items: [{ url: 'https://docs.apify.com/actors' }], total: 1 });
        const client = mockApifyClient({ dataset: () => ({ listItems }) });
        const originalSchema = structuredClone(getDatasetItems.inputSchema);
        const tool = wrapped(getDatasetItems);
        expect(wrapped(getDatasetItems)).toBe(tool);
        expect(Object.isFrozen(tool)).toBe(true);
        const result = await tool.call(stubToolCallContext({ datasetId: 'review-dataset' }, client));
        expect(listItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
        expectSchemaConformingStructuredContent(result, tool.outputSchema!);
        for (const args of [
            { datasetId: 'review-dataset', limit: 101 },
            { datasetId: 'review-dataset', secret: 'excluded' },
        ]) {
            const response = await tool.call(stubToolCallContext(args, client));
            expect(response.isError).toBe(true);
        }
        expect(listItems).toHaveBeenCalledTimes(1);
        expect(getDatasetItems.inputSchema).toEqual(originalSchema);
    });

    it('rejects whole-log reads while retaining a bounded default tail', async () => {
        const get = vi.fn().mockResolvedValue('first\nsecond\n');
        const client = mockApifyClient({ run: () => ({ log: () => ({ get }) }) });
        const tool = wrapped(getActorRunLog);
        expect((await tool.call(stubToolCallContext({ runId: 'review-run', lines: 0 }, client))).isError).toBe(true);
        expect(get).not.toHaveBeenCalled();
        const result = await tool.call(stubToolCallContext({ runId: 'review-run' }, client));
        expectSchemaConformingStructuredContent(result, tool.outputSchema!);
        expect(result.structuredContent).toEqual({ log: 'first\nsecond' });
    });

    it('withholds oversized JSON instead of returning a truncated success', async () => {
        const client = mockApifyClient({
            keyValueStore: () => ({
                getRecord: async () => ({
                    key: 'OUTPUT',
                    value: { content: 'x'.repeat(MAX_INLINE_BYTES) },
                    contentType: 'application/json',
                }),
            }),
        });
        const result = await wrapped(getKeyValueStoreRecord).call(
            stubToolCallContext({ keyValueStoreId: 'review-store', recordKey: 'OUTPUT' }, client),
        );
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.stringify(result)).toContain('Apify Console');
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_INLINE_BYTES);
    });
});

async function caughtRecordError(upstream: unknown): Promise<Error> {
    const client = mockApifyClient({ keyValueStore: () => ({ getRecord: vi.fn().mockRejectedValue(upstream) }) });
    try {
        await wrapped(getKeyValueStoreRecord).call(
            stubToolCallContext({ keyValueStoreId: 'review-store', recordKey: 'OUTPUT' }, client),
        );
    } catch (error) {
        if (error instanceof Error) return error;
        throw new Error('Expected an Error');
    }
    throw new Error('Expected the API failure to propagate');
}

function mapError(error: Error) {
    return buildToolCallErrorResult(error, { toolName: getKeyValueStoreRecord.name, isAborted: false });
}

describe('submission thrown error redaction', () => {
    it('sanitizes model and logging surfaces without retaining raw request fields, stack or cause', async () => {
        const upstream = Object.assign(
            new Error(
                'test-token apify_api_Child123 APIFY_TOKEN=child-run-token; inline JSON: {"APIFY_TOKEN":"legacy-json-token"}',
            ),
            {
                statusCode: 503,
                code: 'ETIMEDOUT',
                config: { headers: { Authorization: 'arbitrary-raw-secret' } },
                response: { data: 'arbitrary-raw-secret' },
                cause: new Error('arbitrary-raw-secret'),
                originalStack: 'arbitrary-raw-secret',
            },
        );
        upstream.stack += '\narbitrary-raw-secret';
        const error = await caughtRecordError(upstream);
        const mapped = mapError(error);
        expect(mapped).toMatchObject({
            kind: TOOL_CALL_ERROR_KIND.EXECUTION,
            toolStatus: TOOL_STATUS.FAILED,
            callDiagnostics: { failure_http_status: 503 },
        });
        expect(error).toMatchObject({ statusCode: 503, code: 'ETIMEDOUT' });
        const exposed = JSON.stringify({
            error: Object.getOwnPropertyDescriptors(error),
            logged: Object.getOwnPropertyDescriptors(toPlainError(error)),
            mapped,
        });
        for (const secret of [
            'test-token',
            'apify_api_Child123',
            'child-run-token',
            'legacy-json-token',
            'arbitrary-raw-secret',
        ]) {
            expect(exposed).not.toContain(secret);
        }
        expect(error).not.toBe(upstream);
        expect(upstream.message).toContain('test-token');
    });

    it('withholds oversized errors while retaining a wrapped account-quota classification', async () => {
        const upstream = Object.assign(
            new Error(`test-token ${'x'.repeat(MAX_INLINE_BYTES)} cannot-start-actor-runs`),
            {
                statusCode: 402,
            },
        );
        const error = await caughtRecordError(upstream);
        expect(error.message).toContain('withheld');
        expect(Buffer.byteLength(error.stack!)).toBeLessThan(MAX_INLINE_BYTES);
        expect(mapError(error)).toMatchObject({
            kind: TOOL_CALL_ERROR_KIND.EXECUTION,
            toolStatus: TOOL_STATUS.SOFT_FAIL,
        });
        expect(JSON.stringify(mapError(error))).not.toContain('test-token');
    });

    it.each(['captured header', 'Apify API body'])('retains a sanitized payment payload from %s', async (source) => {
        const data = {
            x402Version: 2,
            accepts: [],
            APIFY_TOKEN: 'child-token',
            description: 'test-token apify_api_Child123',
        };
        const upstream =
            source === 'captured header'
                ? makePaymentRequiredError(data)
                : new ApifyApiError(
                      {
                          status: 402,
                          data: { error: { type: 'payment-required', message: 'test-token', data } },
                      } as AxiosResponse,
                      1,
                  );
        const error = await caughtRecordError(upstream);
        const mapped = mapError(error);
        expect(mapped.kind).toBe(TOOL_CALL_ERROR_KIND.PAYMENT);
        if (mapped.kind !== TOOL_CALL_ERROR_KIND.PAYMENT) throw new Error('Expected payment handling');
        expect(mapped.response.structuredContent).toMatchObject({
            x402Version: 2,
            accepts: [],
            APIFY_TOKEN: '[REDACTED]',
        });
        for (const secret of ['child-token', 'test-token', 'apify_api_Child123'])
            expect(JSON.stringify(mapped)).not.toContain(secret);
    });

    it('drops oversized payment metadata while preserving the payment response and byte cap', async () => {
        const error = await caughtRecordError(
            makePaymentRequiredError({ description: 'test-token'.repeat(MAX_INLINE_BYTES) }),
        );
        const mapped = mapError(error);
        expect(mapped.kind).toBe(TOOL_CALL_ERROR_KIND.PAYMENT);
        expect(Buffer.byteLength(JSON.stringify(mapped))).toBeLessThan(MAX_INLINE_BYTES);
        expect(JSON.stringify(mapped)).not.toContain('test-token');
    });

    it('retains permission approval handling while dropping unrelated API error data', async () => {
        const upstream = makePermissionApprovalError();
        upstream.message = 'needs approval: test-token';
        upstream.data = {
            approvalUrl: 'https://console.apify.com/approve?token=test-token',
            config: 'arbitrary-raw-secret',
        };
        const error = await caughtRecordError(upstream);
        expect(error).toBeInstanceOf(ApifyApiError);
        expect(mapError(error).kind).toBe(TOOL_CALL_ERROR_KIND.APPROVAL);
        const exposed = JSON.stringify({ fields: Object.getOwnPropertyDescriptors(error), mapped: mapError(error) });
        expect(exposed).toContain('https://console.apify.com/approve');
        expect(exposed).not.toContain('test-token');
        expect(exposed).not.toContain('arbitrary-raw-secret');
    });

    it('retains MCP invalid-parameter classification with sanitized protocol data', async () => {
        const error = await caughtRecordError(
            new McpError(ErrorCode.InvalidParams, 'invalid test-token', {
                APIFY_TOKEN: 'legacy-token',
                description: 'apify_api_Child123',
            }),
        );
        expect(error).toBeInstanceOf(McpError);
        expect(error).toMatchObject({ code: ErrorCode.InvalidParams, data: { APIFY_TOKEN: '[REDACTED]' } });
        expect(mapError(error)).toMatchObject({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            callDiagnostics: { failure_category: FAILURE_CATEGORY.INVALID_INPUT },
        });
        const exposed = JSON.stringify(Object.getOwnPropertyDescriptors(error));
        for (const secret of ['test-token', 'legacy-token', 'apify_api_Child123'])
            expect(exposed).not.toContain(secret);
    });
});

describe('submission response token redaction', () => {
    it('redacts session and Actor tokens in both output representations without changing hashes or the schema', async () => {
        const value = {
            source: 'APIFY_TOKEN=child-run-token\napify_api_Child123 test-token',
            APIFY_TOKEN: 'legacy-or-other-token',
            hash: 'edabc123',
            password: 'private-password',
            count: 2,
        };
        const client = mockApifyClient({
            keyValueStore: () => ({
                getRecord: async () => ({ key: 'OUTPUT', value, contentType: 'application/json' }),
            }),
        });
        const tool = wrapped(getKeyValueStoreRecord);
        const result = await tool.call(
            stubToolCallContext({ keyValueStoreId: 'review-store', recordKey: 'OUTPUT' }, client),
        );
        expectSchemaConformingStructuredContent(result, tool.outputSchema!);
        const json = JSON.stringify(result);
        for (const secret of [
            'child-run-token',
            'apify_api_Child123',
            'test-token',
            'private-password',
            'legacy-or-other-token',
        ])
            expect(json).not.toContain(secret);
        expect(result.structuredContent).toMatchObject({ value: { hash: value.hash, count: 2 } });
        const mirror = result.content?.[0];
        expect(mirror?.type).toBe('text');
        if (mirror?.type === 'text') {
            expect(JSON.parse(mirror.text)).toMatchObject({ value: { APIFY_TOKEN: '[REDACTED]', hash: value.hash } });
        }
        expect(value.source).toContain('child-run-token');
    });

    it('preserves opaque image content within the response cap', async () => {
        const image = Buffer.from('small image bytes');
        const client = mockApifyClient({
            keyValueStore: () => ({
                getRecord: async () => ({ key: 'screenshot.png', value: image, contentType: 'image/png' }),
            }),
        });
        const result = await wrapped(getKeyValueStoreRecord).call(
            stubToolCallContext({ keyValueStoreId: 'review-store', recordKey: 'screenshot.png' }, client),
        );
        expect(result.content?.[0]).toEqual({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
    });
});
