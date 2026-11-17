import { ApifyApiError } from 'apify-client';
import { afterAll, describe, expect, it } from 'vitest';

import { MAX_INLINE_BYTES } from '../../src/const.js';
import { ERROR_BODY_MAX_BYTES, readLogTail, sliceLogTail, TailBuffer } from '../../src/utils/log_tail.js';
import { startLogServer } from './helpers/log_server.js';

const logServer = await startLogServer();

afterAll(async () => logServer.close());

const logUrl = (id: string) => logServer.client.run(id).log().url;

/** A TailBuffer of `maxBytes` fed `chunks`. */
function fill(maxBytes: number, chunks: string[]): TailBuffer {
    const tail = new TailBuffer(maxBytes);
    for (const chunk of chunks) tail.push(Buffer.from(chunk));
    return tail;
}

describe('TailBuffer keeps the end of a stream', () => {
    it('retains at most the window and one chunk of a stream many times the window', () => {
        const chunkSize = 64 * 1024;
        const tail = new TailBuffer(MAX_INLINE_BYTES);
        for (let i = 0; i < 100 * (MAX_INLINE_BYTES / chunkSize); i++) {
            tail.push(Buffer.alloc(chunkSize, 'x'));
            expect(tail.retainedBytes).toBeLessThanOrEqual(MAX_INLINE_BYTES + chunkSize);
        }
        expect(Buffer.byteLength(tail.read().text)).toBe(MAX_INLINE_BYTES);
    });

    it('returns a stream that fits whole', () => {
        expect(fill(10, ['ab\n', 'cd']).read()).toEqual({ text: 'ab\ncd', isTruncated: false, startsMidLine: false });
    });

    it('starts a cut stream at the first line that starts in the window', () => {
        // Window 'cd\nef\n': 'cd' is the end of the line 'abcd'.
        expect(fill(6, ['abcd\nef\n']).read()).toEqual({ text: 'ef\n', isTruncated: true, startsMidLine: false });
    });

    it('keeps the first line when the window starts exactly at a line start', () => {
        expect(fill(6, ['ab\n', 'cd\nef\n']).read()).toEqual({
            text: 'cd\nef\n',
            isTruncated: true,
            startsMidLine: false,
        });
    });

    it('starts a line longer than the window at its first whole character', () => {
        // '€' is 3 bytes; a 7-byte window of '€€€€' starts on the last byte of the second '€'.
        const tail = fill(7, ['€€€€']).read();

        expect(tail).toEqual({ text: '€€', isTruncated: true, startsMidLine: true });
    });

    it('keeps the end of a line longer than the window when that line ends the stream with a newline', () => {
        // Window 'defgh\n': the only newline is the last byte, so no line starts in the window.
        expect(fill(6, ['abcdefgh\n']).read()).toEqual({ text: 'defgh\n', isTruncated: true, startsMidLine: true });
    });

    it('skips at most 3 continuation bytes at the start of a cut line', () => {
        const tail = new TailBuffer(6);
        tail.push(Buffer.from([0x61, 0x80, 0x80, 0x80, 0x80, 0x80, 0x62]));

        // Window: five 0x80 bytes then 'b'; the fourth and fifth stay (decoded as U+FFFD).
        expect(tail.read().text).toBe('\ufffd\ufffdb');
    });
});

describe('sliceLogTail', () => {
    const whole = { isTruncated: false, startsMidLine: false };
    const cut = { isTruncated: true, startsMidLine: false };
    const bytesNote = `${MAX_INLINE_BYTES} bytes`;

    // `note` is a part of the expected note; undefined expects no note.
    it.each([
        ['returns the requested trailing lines without a note when the log was not cut', 'a\nb\nc\n', whole, 2, 'b\nc'],
        ['adds no note when the requested lines all fit in the window', 'a\nb\nc', cut, 2, 'b\nc'],
        ['notes the cut when fewer lines than requested are in the window', 'a\nb', cut, 5, 'a\nb', bytesNote],
        ['notes the cut for lines 0', 'a\nb', cut, 0, 'a\nb', bytesNote],
        [
            'notes the cut when the returned text includes a line cut at its start',
            'long line end',
            { isTruncated: true, startsMidLine: true },
            1,
            'long line end',
            'mid-line',
        ],
    ])('%s', (_name, text, flags, lines, shown, note?: string) => {
        expect(sliceLogTail({ text, ...flags }, lines)).toEqual({
            text: shown,
            note: note && expect.stringContaining(note),
        });
    });
});

describe('readLogTail', () => {
    it('returns undefined for the 404 of a missing run', async () => {
        expect(await readLogTail(logServer.client, logUrl('missing-run'))).toBeUndefined();
    });

    it('throws a 404 that is not a missing record, with its text body as the message', async () => {
        const id = logServer.serveResponses([
            { status: 404, contentType: 'text/html', body: '<html>Not Found</html>' },
        ]);

        const error = await readLogTail(logServer.client, logUrl(id)).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApifyApiError);
        expect(error).toMatchObject({ statusCode: 404, message: 'Unexpected error: "<html>Not Found</html>"' });
    });

    it('sends the client User-Agent', async () => {
        const id = logServer.serveLog('line\n');

        await readLogTail(logServer.client, logUrl(id));

        expect(logServer.userAgent(id)).toMatch(/^ApifyClient\//);
    });

    it('reads an error body only up to ERROR_BODY_MAX_BYTES', async () => {
        const fillerBytes = 64 * 1024 * 1024;
        const id = logServer.serveResponses([{ status: 400, contentType: 'text/plain', fillerBytes }]);

        const error = await readLogTail(logServer.client, logUrl(id)).catch((err: unknown) => err);

        expect((error as ApifyApiError).message.length).toBeLessThan(ERROR_BODY_MAX_BYTES + 100);
        // Socket buffers take some bytes the reader never asks for, far fewer than the body.
        expect(logServer.bytesWritten(id)).toBeLessThan(fillerBytes / 4);
    });

    describe('retries', () => {
        const retryingClient = () => logServer.createClient({ maxRetries: 2, minDelayBetweenRetriesMillis: 1 });

        it.each([
            ['a server error', { status: 500, contentType: 'application/json', body: '{"error":{}}' }],
            ['a connection reset before the headers', { reset: 'before-headers' }],
            ['a connection reset mid-body', { body: 'partial', reset: 'mid-body' }],
        ] as const)('recovers from %s', async (_name, failure) => {
            const id = logServer.serveResponses([failure, { body: 'recovered\n' }]);
            const client = retryingClient();

            expect(await readLogTail(client, client.run(id).log().url)).toMatchObject({ text: 'recovered\n' });
            expect(logServer.requestCount(id)).toBe(2);
        });

        it('throws an error that is not a network failure unchanged, without retrying', async () => {
            const id = logServer.serveLog('line\n');
            const client = retryingClient();
            const bug = new TypeError('interceptor failed');
            client.httpClient.axios.interceptors.request.use(() => {
                throw bug;
            });

            await expect(readLogTail(client, client.run(id).log().url)).rejects.toBe(bug);
            expect(logServer.requestCount(id)).toBe(0);
        });
    });

    it('stops retrying when the signal aborts', async () => {
        const id = logServer.serveResponses([{ status: 500, contentType: 'application/json', body: '{}' }]);
        const client = logServer.createClient({ maxRetries: 3, minDelayBetweenRetriesMillis: 60_000 });
        const controller = new AbortController();

        const reading = readLogTail(client, client.run(id).log().url, controller.signal);
        setTimeout(() => controller.abort(), 50);

        await expect(reading).rejects.toThrow();
        expect(logServer.requestCount(id)).toBe(1);
    });

    it('throws an error naming the broken connection when the body is cut off', async () => {
        const id = logServer.serveResponses([{ body: 'partial line', reset: 'mid-body' }]);

        await expect(readLogTail(logServer.client, logUrl(id))).rejects.toThrow(
            /^The connection broke while reading the log/,
        );
    });
});
