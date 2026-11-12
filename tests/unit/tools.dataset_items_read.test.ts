import { ApifyApiError } from 'apify-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_INLINE_BYTES } from '../../src/const.js';
import { findWholeElementsEnd, readDatasetItems } from '../../src/tools/storage/dataset_items_read.js';
import { type DatasetItemsServer, startDatasetItemsServer } from './helpers/dataset_items_server.js';

/** The whole items of a cut JSON array, as the reader parses them. */
function wholeItemsOf(prefix: Buffer): unknown[] {
    const end = findWholeElementsEnd(prefix);
    return end < 0 ? [] : JSON.parse(`${prefix.subarray(0, end).toString('utf8')}]`);
}

/** Crawler-like items whose page text puts a page of 20 over the size limit. */
function pageItems(count: number, textBytes = 20_000) {
    return Array.from({ length: count }, (_, n) => ({ url: `https://example.com/${n}`, text: 'x'.repeat(textBytes) }));
}

describe('findWholeElementsEnd', () => {
    const items = [
        { title: 'a "quoted" \\ title', nested: { list: [1, [2, 3], { deep: '}]' }] } },
        { title: 'Žluťoučký kůň 🐎', empty: {} },
        { title: 'escape \\u0041 \\"', tags: ['[', ']', ','] },
    ];
    const body = Buffer.from(JSON.stringify(items, null, 1));

    it('keeps exactly the items that end before the cut, wherever the cut falls', () => {
        // Ends of each serialized item in the body, found by serializing growing prefixes.
        const itemEnds = items.map((_, i) => Buffer.byteLength(JSON.stringify(items.slice(0, i + 1), null, 1)) - 2);
        for (let cut = 0; cut < body.length; cut++) {
            const wholeCount = itemEnds.filter((itemEnd) => itemEnd <= cut).length;
            expect(wholeItemsOf(body.subarray(0, cut))).toEqual(items.slice(0, wholeCount));
        }
    });

    it.each([
        { name: 'between items', prefix: '[{"a":1},', expected: [{ a: 1 }] },
        { name: 'inside a string', prefix: '[{"a":1},{"b":"x}', expected: [{ a: 1 }] },
        { name: 'inside an escape', prefix: '[{"a":"\\""},{"b":"\\', expected: [{ a: '"' }] },
        { name: 'inside nested arrays and objects', prefix: '[{"a":[1]},{"b":[{"c":[2', expected: [{ a: [1] }] },
        { name: 'before the first item ends', prefix: '[{"a":', expected: [] },
    ])('reads a cut $name', ({ prefix, expected }) => {
        expect(wholeItemsOf(Buffer.from(prefix))).toEqual(expected);
    });

    it('reads a cut inside a multi-byte character', () => {
        const full = Buffer.from('[{"a":1},{"b":"🐎"}]');
        const cut = full.indexOf(Buffer.from('🐎')) + 2;

        expect(wholeItemsOf(full.subarray(0, cut))).toEqual([{ a: 1 }]);
    });
});

describe('readDatasetItems', () => {
    let server: DatasetItemsServer;
    beforeAll(async () => {
        server = await startDatasetItemsServer();
    });
    afterAll(async () => server.close());

    it('sends the request listItems sends and returns the items and total', async () => {
        server.serve('fits', [{ items: [{ n: 1 }, { n: 2 }], total: 7 }]);
        const options = { clean: true, offset: 2, limit: 2, fields: ['n', 'a'], omit: [], desc: true, flatten: ['a'] };

        const page = await readDatasetItems(server.client, 'fits', options);
        await server.client.dataset('fits').listItems(options);

        expect(page).toEqual({ items: [{ n: 1 }, { n: 2 }], total: 7, isCut: false });
        const [sent, expected] = server.requests('fits');
        expect(sent).toEqual(expected);
    });

    it('keeps the whole items that fit when the body passes the size limit', async () => {
        server.serve('crawl', [{ items: pageItems(30), total: 30 }]);

        const page = await readDatasetItems(server.client, 'crawl', { limit: 20 });

        expect(page.isCut).toBe(true);
        expect(page.total).toBe(30);
        // 20 items of about 20 KB pass the limit; the ones read before it are whole.
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThan(20);
        expect(page.items).toEqual(pageItems(page.items.length));
    });

    it('cuts a compressed body at the size limit of its decompressed bytes', async () => {
        server.serve('compressed', [{ items: pageItems(30), gzip: true }]);

        const page = await readDatasetItems(server.client, 'compressed', { limit: 30 });

        expect(page.isCut).toBe(true);
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThan(30);
    });

    it('returns no items when the first item alone passes the size limit', async () => {
        server.serve('one-big', [{ items: [{ text: 'x'.repeat(MAX_INLINE_BYTES) }, { n: 2 }] }]);

        expect(await readDatasetItems(server.client, 'one-big', { limit: 2 })).toEqual({
            items: [],
            total: 2,
            isCut: true,
        });
    });

    it.each([
        { name: 'ends inside the limit', firstEnd: MAX_INLINE_BYTES - 100, wholeCount: 1 },
        { name: 'ends at the last byte of the limit', firstEnd: MAX_INLINE_BYTES, wholeCount: 1 },
        { name: 'ends one byte past the limit', firstEnd: MAX_INLINE_BYTES + 1, wholeCount: 0 },
    ])('keeps a first item that $name when a second item follows', async ({ name, firstEnd, wholeCount }) => {
        const id = `first-${name.replaceAll(' ', '-')}`;
        // `[` plus `{"t":"…"}`: the first item's last byte is at `firstEnd`.
        const first = { t: 'a'.repeat(firstEnd - 9) };
        server.serve(id, [{ items: [first, { t: 'b'.repeat(40_000) }] }]);

        const page = await readDatasetItems(server.client, id, { limit: 2 });

        expect(page).toEqual({ items: [first].slice(0, wholeCount), total: 2, isCut: true });
    });

    it('reads a page as whole when only its closing bracket passes the limit and it holds every item asked for', async () => {
        const item = { t: 'a'.repeat(MAX_INLINE_BYTES - 9) };
        server.serve('limit-reached', [{ items: [item], total: 5 }]);

        expect(await readDatasetItems(server.client, 'limit-reached', { limit: 1 })).toEqual({
            items: [item],
            total: 5,
            isCut: false,
        });
    });

    it('reads a page as whole when only its closing bracket passes the limit and it ends the dataset', async () => {
        const item = { t: 'a'.repeat(MAX_INLINE_BYTES - 9) };
        server.serve('dataset-end', [{ items: [item], total: 4 }]);

        expect(await readDatasetItems(server.client, 'dataset-end', { offset: 3, limit: 5 })).toEqual({
            items: [item],
            total: 4,
            isCut: false,
        });
    });

    it('reads a page as cut when another item follows the last whole one, whatever the total says', async () => {
        // The total header can lag the items that exist; the comma after the last whole item shows one follows.
        server.serve('lagging-total', [{ items: pageItems(20), total: 25 }]);

        const page = await readDatasetItems(server.client, 'lagging-total', { offset: 20, limit: 20 });

        expect(page.isCut).toBe(true);
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThan(20);
    });

    it.each([
        { name: 'a rate limit', first: { status: 429, body: '{"error":{"type":"rate-limit-exceeded"}}' } },
        { name: 'a server error', first: { status: 500, body: '{"error":{"type":"internal-error"}}' } },
        { name: 'a broken connection', first: { reset: true } },
        { name: 'a body that is not valid JSON', first: { body: '[{"n":1' } },
    ])('retries after $name', async ({ name, first }) => {
        const id = `retry-${name.replaceAll(' ', '-')}`;
        server.serve(id, [first, { items: [{ n: 1 }] }]);
        const client = server.createClient({ maxRetries: 1, minDelayBetweenRetriesMillis: 1 });

        const page = await readDatasetItems(client, id, {});

        expect(page.items).toEqual([{ n: 1 }]);
        expect(server.requests(id)).toHaveLength(2);
    });

    it('throws a client error at once as ApifyApiError', async () => {
        server.serve('bad-request', [{ status: 400, body: '{"error":{"type":"invalid-parameter","message":"Bad"}}' }]);
        const client = server.createClient({ maxRetries: 3, minDelayBetweenRetriesMillis: 1 });

        const error = await readDatasetItems(client, 'bad-request', {}).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApifyApiError);
        expect(error).toMatchObject({ statusCode: 400, type: 'invalid-parameter', message: 'Bad' });
        expect(server.requests('bad-request')).toHaveLength(1);
    });

    it('stops retrying when the signal aborts', async () => {
        server.serve('aborted', [{ status: 500, body: '{}' }]);
        const client = server.createClient({ maxRetries: 3, minDelayBetweenRetriesMillis: 60_000 });
        const controller = new AbortController();

        const read = readDatasetItems(client, 'aborted', {}, controller.signal);
        setTimeout(() => controller.abort(), 50);

        await expect(read).rejects.toThrow();
        expect(server.requests('aborted')).toHaveLength(1);
    });

    it("sends the client's User-Agent", async () => {
        server.serve('agent', [{ items: [] }]);

        await readDatasetItems(server.client, 'agent', {});

        expect(server.requests('agent')[0].userAgent).toMatch(/^ApifyClient\//);
    });
});
