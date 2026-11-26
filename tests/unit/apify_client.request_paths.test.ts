/** ApifyClient: identifiers and record keys reach the request URL as one path segment each. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient, sendApifyApiRequest } from '../../src/apify_client.js';
import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { InvalidRequestPathError } from '../../src/errors.js';
import { buildToolCallErrorResult } from '../../src/mcp/tool_call_error_mapper.js';
import { type FetchAnswer, jsonResponse, stubFetch } from './helpers/fetch_stub.js';

const API = 'https://api.apify.com';

const NOT_FOUND = { error: { type: 'record-not-found', message: 'Not found' } };

/**
 * A client whose requests stop at a stubbed `fetch`, after apify-client's pipeline; `urls` lists what was sent,
 * without the query. A read is answered with a 404, which the client reads as a missing resource, and a write with an empty 204.
 */
function buildRecordingClient(answer?: FetchAnswer): { client: ApifyClient; urls: string[] } {
    const urls: string[] = [];
    stubFetch((request) => {
        urls.push(request.url.split('?', 1)[0]);
        if (answer) return answer(request);
        return request.method === 'GET' || request.method === 'HEAD'
            ? jsonResponse(NOT_FOUND, 404)
            : new Response(null, { status: 204 });
    });
    return { client: new ApifyClient({ token: 'test-token', baseUrl: API, maxRetries: 0 }), urls };
}

afterEach(() => vi.unstubAllGlobals());

describe('resource identifiers', () => {
    it.each([
        [
            'an ID',
            async (client: ApifyClient) => client.run('a1B2c3D4e5F6g7H8i').get(),
            `${API}/v2/actor-runs/a1B2c3D4e5F6g7H8i`,
        ],
        [
            'a username/name',
            async (client: ApifyClient) => client.actor('apify/web-scraper').get(),
            `${API}/v2/actors/apify~web-scraper`,
        ],
        [
            'a username~name with a dot and an underscore',
            async (client: ApifyClient) => client.dataset('john.doe_1~my-data').get(),
            `${API}/v2/datasets/john.doe_1~my-data`,
        ],
        [
            'a ~name',
            async (client: ApifyClient) => client.keyValueStore('~my-store').get(),
            `${API}/v2/key-value-stores/~my-store`,
        ],
    ])('sends %s as given', async (_label, call, expectedUrl) => {
        const { client, urls } = buildRecordingClient();

        await call(client);

        expect(urls).toEqual([expectedUrl]);
    });

    it.each([
        ['a trailing newline', async (client: ApifyClient) => client.run('a1B2c3D4e5F6g7H8i\n').get()],
        ['surrounding spaces', async (client: ApifyClient) => client.run('  a1B2c3D4e5F6g7H8i ').get()],
    ])('sends an identifier with %s without the whitespace', async (_label, call) => {
        const { client, urls } = buildRecordingClient();

        await call(client);

        expect(urls).toEqual([`${API}/v2/actor-runs/a1B2c3D4e5F6g7H8i`]);
    });

    it('refuses an identifier with whitespace inside it', async () => {
        const { client, urls } = buildRecordingClient();

        await expect(async () => client.run('a1B2c3D4 e5F6g7H8i').get()).rejects.toMatchObject({ statusCode: 400 });
        expect(urls).toEqual([]);
    });

    it.each([
        ['a second slash', async (client: ApifyClient) => client.actor('a/b/c').get()],
        ['a dot segment', async (client: ApifyClient) => client.run('..').get()],
        ['a query character', async (client: ApifyClient) => client.dataset('a?x=1').listItems()],
        ['a fragment character', async (client: ApifyClient) => client.task('a#x').get()],
        ['a percent sign', async (client: ApifyClient) => client.build('a%2Fb').get()],
    ])('refuses an identifier with %s without sending a request', async (_label, call) => {
        const { client, urls } = buildRecordingClient();

        // The 400 makes callers treat it as the API's own rejection of bad input.
        await expect(call(client)).rejects.toMatchObject({ statusCode: 400 });
        expect(urls).toEqual([]);
    });
});

describe('record keys', () => {
    const STORE = 'a1B2c3D4e5F6g7H8i';
    const KEY = "OUTPUT.json-(1)!_'";
    const recordMethods: [string, (client: ApifyClient, key: string) => Promise<unknown>][] = [
        ['getRecord', async (client, key) => client.keyValueStore(STORE).getRecord(key)],
        ['recordExists', async (client, key) => client.keyValueStore(STORE).recordExists(key)],
        ['setRecord', async (client, key) => client.keyValueStore(STORE).setRecord({ key, value: 'x' })],
        ['deleteRecord', async (client, key) => client.keyValueStore(STORE).deleteRecord(key)],
    ];

    it.each(recordMethods)("%s sends a key of the platform's character set as given", async (_method, call) => {
        const { client, urls } = buildRecordingClient();

        await call(client, KEY);

        expect(urls).toEqual([`${API}/v2/key-value-stores/${STORE}/records/${KEY}`]);
    });

    it.each(recordMethods)(
        '%s refuses a key with a query character without sending a request',
        async (_method, call) => {
            const { client, urls } = buildRecordingClient();

            await expect(call(client, 'OUTPUT?x=1')).rejects.toMatchObject({ statusCode: 400 });
            expect(urls).toEqual([]);
        },
    );

    it('sends a key of 256 characters', async () => {
        const { client, urls } = buildRecordingClient();
        const key = 'a'.repeat(256);

        await client.keyValueStore(STORE).getRecord(key);

        expect(urls).toEqual([`${API}/v2/key-value-stores/${STORE}/records/${key}`]);
    });

    it.each([
        ['a run', (client: ApifyClient) => client.run(STORE).keyValueStore()],
        ["an Actor's last run", (client: ApifyClient) => client.actor('a/b').lastRun().keyValueStore()],
        ["a task's last run", (client: ApifyClient) => client.task('a~b').lastRun().keyValueStore()],
    ])('checks record keys in the key-value store of %s', async (_label, getStore) => {
        const { client, urls } = buildRecordingClient();

        await expect(getStore(client).getRecord('a/b')).rejects.toMatchObject({ statusCode: 400 });
        await getStore(client).getRecord(KEY);

        expect(urls).toEqual([expect.stringMatching(/\/key-value-store\/records\/OUTPUT\.json-\(1\)!_'$/)]);
    });

    it('getRecordPublicUrl builds the link from a valid key and refuses any other', async () => {
        const now = new Date().toISOString();
        const store = { id: STORE, userId: 'u1', createdAt: now, modifiedAt: now, accessedAt: now };
        const { client, urls } = buildRecordingClient(() => jsonResponse({ data: store }));
        const storeClient = client.keyValueStore(STORE);

        await expect(storeClient.getRecordPublicUrl(KEY)).resolves.toBe(
            `${API}/v2/key-value-stores/${STORE}/records/${KEY}`,
        );
        await expect(storeClient.getRecordPublicUrl('a/../b')).rejects.toMatchObject({ statusCode: 400 });
        // Only the store read for the valid key.
        expect(urls).toEqual([`${API}/v2/key-value-stores/${STORE}`]);
    });

    it.each([
        ['that is a dot segment', '..'],
        ['with a slash', 'a/b'],
        ['with a percent sign', 'a%2Fb'],
        ['with a non-ASCII character', 'v\u00e9'],
        ['of 257 characters', 'a'.repeat(257)],
    ])('refuses a key %s', async (_label, key) => {
        const { client, urls } = buildRecordingClient();

        await expect(client.keyValueStore(STORE).getRecord(key)).rejects.toMatchObject({ statusCode: 400 });
        expect(urls).toEqual([]);
    });
});

describe('request URLs', () => {
    // A version number is not checked as an identifier here; apify-client percent-encodes it into one path segment.
    it.each([
        ['a slash', '0.1/a', '0.1~a'],
        ['a backslash', '0.1\\x', '0.1%5Cx'],
        ['a query', '0.1?x=1', '0.1%3Fx%3D1'],
        ['a fragment', '0.1#x', '0.1%23x'],
    ])('sends a path value with %s as one encoded segment', async (_label, versionNumber, segment) => {
        const { client, urls } = buildRecordingClient();

        await client.actor('apify/web-scraper').version(versionNumber).get();

        expect(urls).toEqual([`${API}/v2/actors/apify~web-scraper/versions/${segment}`]);
    });

    it('sends the query of a URL passed to sendApifyApiRequest', async () => {
        const { requests } = stubFetch();
        const client = new ApifyClient({ token: 'test-token', baseUrl: API });
        const url = `${API}/v2/datasets/a1B2c3D4e5F6g7H8i/items?limit=1`;

        await sendApifyApiRequest(client, { url, method: 'GET' });

        expect(requests.map((request) => request.url)).toEqual([url]);
    });

    it.each([
        ['a dot segment', `${API}/v2/datasets/a/../b`],
        ['a percent-encoded dot segment', `${API}/v2/datasets/a/%2e%2e/b`],
        ['a backslash', `${API}/v2/datasets\\x`],
        ['a character a URL path cannot hold unencoded', `${API}/v2/datasets/a b`],
        ['no origin', '/v2/users/me'],
    ])('refuses a URL with %s without sending a request', async (_label, url) => {
        const { client, urls } = buildRecordingClient();

        await expect(sendApifyApiRequest(client, { url, method: 'GET' })).rejects.toBeInstanceOf(
            InvalidRequestPathError,
        );
        expect(urls).toEqual([]);
    });
});

describe('a refused request', () => {
    it('reaches the caller as a soft-failed input error', () => {
        const error = new InvalidRequestPathError('Invalid record key "a?x=1".');
        const result = buildToolCallErrorResult(error, { toolName: 'get-key-value-store-record', isAborted: false });

        expect(result.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
        expect(result.callDiagnostics).toMatchObject({
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_http_status: 400,
        });
        // The message is already the text to show, so it is not wrapped again.
        expect(result).toMatchObject({ userText: error.message });
    });
});
