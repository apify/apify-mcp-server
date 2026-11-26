import { vi } from 'vitest';

/** One request as it reached `fetch`, after apify-client's pipeline and the client's own `fetch` wrapper. */
export type SentRequest = { url: string; method: string; headers: Headers; body: unknown };

/** What a stubbed `fetch` answers with: a `Response`, or an error to reject with. */
export type FetchAnswer = (request: SentRequest) => Response | Promise<Response>;

/** A JSON response of the Apify API. */
export function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Replaces the global `fetch`, which the client sends through, so nothing leaves the process. `requests` lists
 * what was sent. Restore with `vi.unstubAllGlobals()` in `afterEach`.
 */
export function stubFetch(answer: FetchAnswer = () => jsonResponse({ data: { id: 'a1B2c3D4e5F6g7H8i' } })): {
    requests: SentRequest[];
} {
    const requests: SentRequest[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const request = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body };
        requests.push(request);
        return answer(request);
    });
    return { requests };
}
