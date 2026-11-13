/** ApifyClient: identifiers and record keys reach the request URL as one path segment each. */
import { describe, expect, it } from 'vitest';

import { ApifyClient, sendApifyApiRequest } from '../../src/apify_client.js';
import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { InvalidRequestPathError } from '../../src/errors.js';
import { buildToolCallErrorResult } from '../../src/mcp/tool_call_error_mapper.js';

const API = 'https://api.apify.com';

/** A client whose requests stop at a stub adapter, after the real interceptor chain; `urls` lists what was sent. */
function buildRecordingClient(): { client: ApifyClient; urls: string[] } {
    const urls: string[] = [];
    const client = new ApifyClient({ token: 'test-token', baseUrl: API, maxRetries: 0 });
    client.httpClient.axios.defaults.adapter = async (config) => {
        urls.push(config.url!);
        return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            config,
            data: Buffer.from(JSON.stringify({ data: { id: 'a1B2c3D4e5F6g7H8i' } })),
        };
    };
    return { client, urls };
}

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
        const { client, urls } = buildRecordingClient();
        const store = client.keyValueStore(STORE);

        await expect(store.getRecordPublicUrl(KEY)).resolves.toBe(`${API}/v2/key-value-stores/${STORE}/records/${KEY}`);
        await expect(store.getRecordPublicUrl('a/../b')).rejects.toMatchObject({ statusCode: 400 });
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
    // A version number is not checked as an identifier, so these reach the interceptor. apify-client turns its first
    // "/" into "~".
    it.each([
        ['a dot segment', '0.1/a/../b'],
        ['a percent-encoded dot segment', '0.1/a/%2e%2e/b'],
        ['a backslash', '0.1\\x'],
        ['a query', '0.1?x=1'],
        ['a fragment', '0.1#x'],
    ])('refuses a path value that adds %s without sending a request', async (_label, versionNumber) => {
        const { client, urls } = buildRecordingClient();

        await expect(client.actor('apify/web-scraper').version(versionNumber).get()).rejects.toMatchObject({
            statusCode: 400,
        });
        expect(urls).toEqual([]);
    });

    it('sends the query of a URL passed to sendApifyApiRequest', async () => {
        const { client, urls } = buildRecordingClient();
        const url = `${API}/v2/datasets/a1B2c3D4e5F6g7H8i/items?limit=1`;

        await sendApifyApiRequest(client, { url, method: 'GET' });

        expect(urls).toEqual([url]);
    });

    it('joins a relative URL to its baseURL before checking it', async () => {
        const { client, urls } = buildRecordingClient();

        await client.httpClient.axios.request({ baseURL: `${API}/v2`, url: 'users/me' });
        await expect(client.httpClient.axios.request({ baseURL: `${API}/v2`, url: '../x' })).rejects.toMatchObject({
            statusCode: 400,
        });

        expect(urls).toEqual(['users/me']);
    });

    it.each([
        // Read as absolute, as the HTTP library reads it.
        ['a protocol-relative URL', { baseURL: `${API}/v2`, url: '//example.com/x' }],
        ['a relative URL with no baseURL', { url: '/v2/users/me' }],
    ])('refuses %s', async (_label, config) => {
        const { client, urls } = buildRecordingClient();

        await expect(client.httpClient.axios.request(config)).rejects.toMatchObject({ statusCode: 400 });
        expect(urls).toEqual([]);
    });
});

describe('a refused request', () => {
    it('reaches the caller as a soft-failed input error', () => {
        const result = buildToolCallErrorResult(new InvalidRequestPathError('Invalid record key "a?x=1".'), {
            toolName: 'get-key-value-store-record',
            isAborted: false,
        });

        expect(result.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
        expect(result.callDiagnostics).toMatchObject({
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_http_status: 400,
        });
    });
});
