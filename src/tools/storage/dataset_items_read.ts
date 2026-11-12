import { setTimeout as sleep } from 'node:timers/promises';

import type { DatasetClientListItemOptions } from 'apify-client';
import { ApifyApiError, InvalidResponseBodyError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { isAxiosError, isCancel } from 'axios';

import type { ApifyClient } from '../../apify_client.js';
import { MAX_INLINE_BYTES } from '../../const.js';

/**
 * A page of dataset items. `isCut` when the body passed `MAX_INLINE_BYTES`: `items` then holds the whole
 * items that arrived before the limit, possibly none.
 */
export type DatasetItemsPage = { items: Record<string, unknown>[]; total: number; isCut: boolean };

/**
 * Error codes of a connection that breaks or stalls while the body streams; the stream then throws a plain
 * error, not an AxiosError.
 */
const STREAM_NETWORK_ERROR_CODES: ReadonlySet<string | undefined> = new Set([
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'ERR_STREAM_PREMATURE_CLOSE',
]);

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/**
 * The byte length of the whole top-level elements at the start of a cut JSON array (`[` included, without a
 * trailing comma), or -1 when none is whole. One pass over the bytes, tracking nesting, strings and escapes.
 * The structural characters are ASCII, which never occur inside a multi-byte UTF-8 character, so a character
 * split by the cut is only ever inside the part after the end.
 */
export function findWholeElementsEnd(prefix: Buffer): number {
    let depth = 0;
    let isInString = false;
    let end = -1;
    for (let i = 0; i < prefix.length; i++) {
        const byte = prefix[i];
        if (isInString) {
            if (byte === BACKSLASH) i++;
            else if (byte === QUOTE) isInString = false;
        } else if (byte === QUOTE) {
            isInString = true;
        } else if (byte === OPEN_BRACKET || byte === OPEN_BRACE) {
            depth++;
        } else if (byte === CLOSE_BRACKET || byte === CLOSE_BRACE) {
            depth--;
            if (depth === 1) end = i + 1;
        } else if (byte === COMMA && depth === 1) {
            end = i;
        }
    }
    return end;
}

/** The body as JSON, failing as apify-client fails a body it cannot parse, which it retries. */
function parseJsonBody(text: string, response: AxiosResponse<unknown>): unknown {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new InvalidResponseBodyError(response, err as Error);
    }
}

/** The `ApifyApiError` of an error response, from its body as apify-client parses it. */
function toApiError(response: AxiosResponse<unknown>, body: Buffer, attempt: number): ApifyApiError {
    let data: unknown = body.length > 0 ? body.toString('utf8') : undefined;
    try {
        if (typeof data === 'string') data = JSON.parse(data);
    } catch {
        // A body that is not JSON stays text.
    }
    return new ApifyApiError({ ...response, data } as AxiosResponse, attempt);
}

/**
 * The first `MAX_INLINE_BYTES` of a streamed body, `isTruncated` when more followed. Reading stops there: the
 * chunk that crosses the limit is kept up to it and leaving the loop destroys the stream.
 */
async function readBodyPrefix(stream: AsyncIterable<Buffer>): Promise<{ body: Buffer; isTruncated: boolean }> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
        if (bytes + chunk.length > MAX_INLINE_BYTES) {
            chunks.push(chunk.subarray(0, MAX_INLINE_BYTES - bytes));
            return { body: Buffer.concat(chunks), isTruncated: true };
        }
        chunks.push(chunk);
        bytes += chunk.length;
    }
    return { body: Buffer.concat(chunks), isTruncated: false };
}

/** One request; the body is read up to `MAX_INLINE_BYTES`. */
async function readDatasetItemsOnce(
    client: ApifyClient,
    url: string,
    options: DatasetClientListItemOptions,
    attempt: number,
    signal?: AbortSignal,
): Promise<DatasetItemsPage> {
    // One attempt through the client's axios instance, which adds the token and headers; `readBodyPrefix` caps the body.
    const response = await client.httpClient.axios.request<AsyncIterable<Buffer>>({
        url,
        method: 'GET',
        params: options,
        responseType: 'stream',
        signal,
    });
    const { body, isTruncated } = await readBodyPrefix(response.data);
    if (response.status >= 300) throw toApiError(response, body, attempt);
    const total = Number(response.headers['x-apify-pagination-total']);
    if (!isTruncated) {
        const items = parseJsonBody(body.toString('utf8'), response) as Record<string, unknown>[];
        return { items, total, isCut: false };
    }
    const end = findWholeElementsEnd(body);
    const items =
        end < 0
            ? []
            : (parseJsonBody(`${body.subarray(0, end).toString('utf8')}]`, response) as Record<string, unknown>[]);
    // When only the closing bracket passed the limit, the page holds every item asked for or reaches the end of
    // the dataset; `total` counts the items before `clean` skips any, as `offset` does.
    const isComplete =
        (options.limit !== undefined && items.length >= options.limit) || (options.offset ?? 0) + items.length >= total;
    return { items, total, isCut: !isComplete };
}

/** A connection that broke or stalled while the body streamed. */
function isStreamNetworkError(error: unknown): boolean {
    return (
        error instanceof Error &&
        !isAxiosError(error) &&
        STREAM_NETWORK_ERROR_CODES.has((error as NodeJS.ErrnoException).code)
    );
}

/**
 * Retried as apify-client's `call()` retries: rate limits and server errors, network failures (axios errors
 * that carry the request, and a connection that breaks mid-body), and a body that cannot be parsed.
 */
function isRetryable(error: unknown): boolean {
    if (error instanceof ApifyApiError) return error.statusCode === 429 || error.statusCode >= 500;
    if (error instanceof InvalidResponseBodyError) return true;
    if (isAxiosError(error)) return !isCancel(error) && Boolean(error.request);
    return isStreamNetworkError(error);
}

/**
 * Lists dataset items with the options of `DatasetClient.listItems` and the same request, reading the body
 * only up to `MAX_INLINE_BYTES` (`readBodyToCap`); a page cut there keeps its whole items. Rate limits,
 * server errors, network failures and unparseable bodies are retried with the client's `maxRetries` and
 * backoff until `signal` aborts; any other error, such as a 404, is thrown as `ApifyApiError` at once.
 */
export async function readDatasetItems(
    client: ApifyClient,
    safeId: string,
    options: DatasetClientListItemOptions,
    signal?: AbortSignal,
): Promise<DatasetItemsPage> {
    const { httpClient } = client;
    // Sets the client's User-Agent, as its own `call()` does first; a client without this method sends none.
    const { ensureNodeInit } = httpClient as unknown as { ensureNodeInit?: () => Promise<void> };
    if (typeof ensureNodeInit === 'function') await ensureNodeInit.call(httpClient);
    const url = `${client.dataset(safeId).url}/items`;
    for (let attempt = 1; ; attempt++) {
        try {
            return await readDatasetItemsOnce(client, url, options, attempt, signal);
        } catch (error) {
            // An abort can surface as a stream error; it is never retried.
            if (signal?.aborted || attempt > httpClient.maxRetries || !isRetryable(error)) throw error;
            // apify-client's backoff (async-retry defaults): doubling from the minimum delay, randomized up to 2x.
            const delayMillis = httpClient.minDelayBetweenRetriesMillis * 2 ** (attempt - 1) * (1 + Math.random());
            await sleep(delayMillis, undefined, { signal });
        }
    }
}
