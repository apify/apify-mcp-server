import { setTimeout as sleep } from 'node:timers/promises';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { isAxiosError, isCancel } from 'axios';

import type { ApifyClient } from '../apify_client.js';
import { HTTP_NOT_FOUND, MAX_INLINE_BYTES } from '../const.js';

/** An error body is read up to this many bytes, from its start: enough for the API's JSON error. */
export const ERROR_BODY_MAX_BYTES = 16 * 1024;

/** The 404 error types apify-client reads as a missing resource (`catchNotFoundOrThrow`). */
const NOT_FOUND_ERROR_TYPES: readonly (string | undefined)[] = ['record-not-found', 'record-or-token-not-found'];

/**
 * Error codes of a connection that breaks or stalls while the body streams; the stream then throws a plain
 * error, not an AxiosError ("aborted" with ECONNRESET for a reset, and for a stall that hits the timeout).
 */
const STREAM_NETWORK_ERROR_CODES: ReadonlySet<string | undefined> = new Set([
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'ERR_STREAM_PREMATURE_CLOSE',
]);

const NEWLINE = 0x0a;

/** The end of a log: `isTruncated` when earlier bytes were dropped, `startsMidLine` when `text` begins inside a line. */
export type LogTail = { text: string; isTruncated: boolean; startsMidLine: boolean };

/** The last `maxBytes` of a byte stream, pushed chunk by chunk. It holds at most `maxBytes` plus one chunk. */
export class TailBuffer {
    private readonly chunks: Buffer[] = [];
    private retained = 0;
    /** The last byte dropped, which tells whether the kept bytes start a line. */
    private lastDroppedByte: number | undefined;

    constructor(private readonly maxBytes: number) {}

    get retainedBytes(): number {
        return this.retained;
    }

    push(chunk: Buffer): void {
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
            const firstLineEnd = body.indexOf(NEWLINE);
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

/**
 * The `ApifyApiError` of an error response, from the start of its body, decoded as apify-client decodes a
 * buffered one: JSON when the Content-Type says so, otherwise text.
 */
async function readApiError(response: AxiosResponse<AsyncIterable<Buffer>>, attempt: number): Promise<ApifyApiError> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.data) {
        chunks.push(chunk);
        bytes += chunk.length;
        // Leaving the loop destroys the stream.
        if (bytes >= ERROR_BODY_MAX_BYTES) break;
    }
    const text = Buffer.concat(chunks).subarray(0, ERROR_BODY_MAX_BYTES).toString('utf8');
    let data: unknown = text || undefined;
    if (data && String(response.headers['content-type']).includes('application/json')) {
        try {
            data = JSON.parse(text);
        } catch {
            // A cut or malformed JSON body stays text.
        }
    }
    return new ApifyApiError({ ...response, data } as AxiosResponse, attempt);
}

/** One request; `undefined` for the 404 of a missing run or build. */
async function readLogTailOnce(
    apifyClient: ApifyClient,
    url: string,
    attempt: number,
    signal?: AbortSignal,
): Promise<LogTail | undefined> {
    const response = await apifyClient.httpClient.axios.request<AsyncIterable<Buffer>>({
        url,
        method: 'GET',
        responseType: 'stream',
        signal,
    });
    if (response.status >= 300) {
        const error = await readApiError(response, attempt);
        if (error.statusCode === HTTP_NOT_FOUND && NOT_FOUND_ERROR_TYPES.includes(error.type)) return undefined;
        throw error;
    }
    const tail = new TailBuffer(MAX_INLINE_BYTES);
    for await (const chunk of response.data) tail.push(chunk);
    return tail.read();
}

/** A connection that broke or stalled while the body streamed. */
function isStreamNetworkError(error: unknown): error is NodeJS.ErrnoException {
    return (
        error instanceof Error &&
        !isAxiosError(error) &&
        STREAM_NETWORK_ERROR_CODES.has((error as NodeJS.ErrnoException).code)
    );
}

/**
 * Retried as apify-client's `call()` retries: rate limits and server errors, and network failures, which are
 * axios errors that carry the request and, here, also a connection that breaks mid-body.
 */
function isRetryable(error: unknown): boolean {
    if (error instanceof ApifyApiError) return error.statusCode === 429 || error.statusCode >= 500;
    if (isAxiosError(error)) return !isCancel(error) && Boolean(error.request);
    return isStreamNetworkError(error);
}

/**
 * The end of a run or build log (`url` is the log client's, `client.run(id).log().url`): its last
 * `MAX_INLINE_BYTES` at most, see `TailBuffer.read`. The body is streamed and only that window is kept, so a
 * long log is never held whole. `undefined` when the run or build does not exist. Rate limits, server errors
 * and network failures are retried with the client's `maxRetries` and backoff until `signal` aborts; any
 * other error is thrown at once.
 */
export async function readLogTail(
    apifyClient: ApifyClient,
    url: string,
    signal?: AbortSignal,
): Promise<LogTail | undefined> {
    const { httpClient } = apifyClient;
    // Sets the client's User-Agent, as its own `call()` does first; a client without this method sends none.
    const { ensureNodeInit } = httpClient as unknown as { ensureNodeInit?: () => Promise<void> };
    if (typeof ensureNodeInit === 'function') await ensureNodeInit.call(httpClient);
    for (let attempt = 1; ; attempt++) {
        try {
            return await readLogTailOnce(apifyClient, url, attempt, signal);
        } catch (error) {
            // An abort can surface as a stream error; it is never retried or reworded.
            if (signal?.aborted) throw error;
            if (attempt <= httpClient.maxRetries && isRetryable(error)) {
                // apify-client's backoff (async-retry defaults): doubling from the minimum delay, randomized up to 2x.
                const delayMillis = httpClient.minDelayBetweenRetriesMillis * 2 ** (attempt - 1) * (1 + Math.random());
                await sleep(delayMillis, undefined, { signal });
                continue;
            }
            if (!isStreamNetworkError(error)) throw error;
            const reason = `${error.message}${error.code ? ` (${error.code})` : ''}`;
            throw new Error(`The connection broke while reading the log: ${reason}.`, { cause: error });
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
