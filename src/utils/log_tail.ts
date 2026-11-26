import { setTimeout as sleep } from 'node:timers/promises';

import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../apify_client.js';
import { HTTP_NOT_FOUND, MAX_INLINE_BYTES } from '../const.js';

/** The 404 error types apify-client reads as a missing resource (`catchNotFoundOrThrow`). */
const NOT_FOUND_ERROR_TYPES: readonly (string | undefined)[] = ['record-not-found', 'record-or-token-not-found'];

const NEWLINE = 0x0a;

/** The `lines` argument of the run and build log tools. */
export const logLinesSchema = z
    .number()
    .int()
    .min(0)
    .max(50)
    .describe(
        `Output the last NUM lines, instead of the last 10. Pass 0 to return the entire log, up to its last ${MAX_INLINE_BYTES} bytes.`,
    )
    .default(10);

/** The end of a log: `isTruncated` when earlier bytes were dropped, `startsMidLine` when `text` begins inside a line. */
export type LogTail = { text: string; isTruncated: boolean; startsMidLine: boolean };

/** The last `maxBytes` of a byte stream, pushed chunk by chunk. It holds at most `maxBytes` plus one chunk. */
export class TailBuffer {
    private readonly chunks: Uint8Array[] = [];
    private retained = 0;
    /** The last byte dropped, which tells whether the kept bytes start a line. */
    private lastDroppedByte: number | undefined;

    constructor(private readonly maxBytes: number) {}

    get retainedBytes(): number {
        return this.retained;
    }

    push(chunk: Uint8Array): void {
        if (chunk.length === 0) return;
        this.chunks.push(chunk);
        this.retained += chunk.length;
        // Drop whole chunks while the rest still fills the window.
        while (this.retained - this.chunks[0].length >= this.maxBytes) {
            const dropped = this.chunks.shift()!;
            this.retained -= dropped.length;
            this.lastDroppedByte = dropped[dropped.length - 1];
        }
    }

    /**
     * The kept bytes as text. A cut log starts at the first line that starts in the window; when no line
     * starts there, at the first whole character of the one line, with `startsMidLine`.
     */
    read(): LogTail {
        let body = Buffer.concat(this.chunks);
        let { lastDroppedByte } = this;
        if (body.length > this.maxBytes) {
            lastDroppedByte = body[body.length - this.maxBytes - 1];
            body = body.subarray(body.length - this.maxBytes);
        }
        const isTruncated = lastDroppedByte !== undefined;
        let startsMidLine = isTruncated && lastDroppedByte !== NEWLINE;
        if (startsMidLine) {
            // A newline that ends the window starts no line in it, so it is not searched.
            const firstLineEnd = body.subarray(0, body.length - 1).indexOf(NEWLINE);
            if (firstLineEnd === -1) {
                // Skip the UTF-8 continuation bytes (10xxxxxx, at most 3) of a character that started before the window.
                let start = 0;
                while (start < 3 && start < body.length && (body[start] & 0xc0) === 0x80) start++;
                body = body.subarray(start);
            } else {
                body = body.subarray(firstLineEnd + 1);
                startsMidLine = false;
            }
        }
        return { text: body.toString('utf8'), isTruncated, startsMidLine };
    }
}

/** Whether `error` is the 404 of a missing run or build. */
function isMissingLogError(error: unknown): boolean {
    return (
        error instanceof ApifyApiError &&
        error.statusCode === HTTP_NOT_FOUND &&
        NOT_FOUND_ERROR_TYPES.includes(error.type)
    );
}

/** The underlying network error of a `fetch` failure, which Node.js puts in `cause`. */
function describeBrokenConnection(error: unknown): string {
    const cause: unknown = error instanceof Error ? (error.cause ?? error) : error;
    if (!(cause instanceof Error)) return String(cause);
    const { code } = cause as NodeJS.ErrnoException;
    return `${cause.message}${code ? ` (${code})` : ''}`;
}

/**
 * The end of a run or build log (`url` is the log client's, `client.run(id).log().url`): its last
 * `MAX_INLINE_BYTES` at most, see `TailBuffer.read`. The body is streamed and only that window is kept, so a
 * long log is never held whole. `undefined` when the run or build does not exist. apify-client's `call()`
 * retries rate limits, server errors and network failures until the response headers arrive. A connection
 * that breaks mid-body is retried here, with the client's `maxRetries` and backoff, until `signal` aborts.
 */
export async function readLogTail(
    apifyClient: ApifyClient,
    url: string,
    signal?: AbortSignal,
): Promise<LogTail | undefined> {
    const { httpClient } = apifyClient;
    for (let attempt = 1; ; attempt++) {
        let body: ReadableStream<Uint8Array>;
        try {
            ({ data: body } = await httpClient.call<ReadableStream<Uint8Array>>({
                url,
                method: 'GET',
                responseType: 'stream',
                timeoutSecs: 'long',
                signal,
            }));
        } catch (error) {
            if (isMissingLogError(error)) return undefined;
            throw error;
        }
        try {
            const tail = new TailBuffer(MAX_INLINE_BYTES);
            for await (const chunk of body) tail.push(chunk);
            return tail.read();
        } catch (error) {
            // An abort surfaces as a stream error; it is never retried or reworded.
            if (signal?.aborted || !httpClient.isRetryableTransportError(error)) throw error;
            if (attempt > httpClient.maxRetries) {
                const reason = describeBrokenConnection(error);
                throw new Error(`The connection broke while reading the log: ${reason}.`, { cause: error });
            }
            // apify-client's backoff: doubling from the minimum delay, randomized up to 2x.
            const delayMillis = httpClient.minDelayBetweenRetriesMillis * 2 ** (attempt - 1) * (1 + Math.random());
            await sleep(delayMillis, undefined, { signal });
        }
    }
}

/**
 * The last `lines` lines of a log tail (all of them for 0), and a note when the text reaches back to where the
 * log was cut and so holds less than asked: a cut first line, or fewer lines than requested.
 */
export function sliceLogTail(tail: LogTail, lines: number): { text: string; note?: string } {
    // Logs from the API end with a newline; drop it so the slice counts only content lines.
    const all = tail.text.replace(/\n$/, '').split('\n');
    const shown = lines === 0 ? all : all.slice(-lines);
    const isShortOfRequest = tail.startsMidLine || lines === 0 || shown.length < lines;
    const isCut = tail.isTruncated && shown.length === all.length && isShortOfRequest;
    const note = isCut
        ? `The log is longer than ${MAX_INLINE_BYTES} bytes; only the text in its last ${MAX_INLINE_BYTES} bytes is returned${tail.startsMidLine ? ', starting mid-line' : ''}.`
        : undefined;
    return { text: shown.join('\n'), ...(note && { note }) };
}
