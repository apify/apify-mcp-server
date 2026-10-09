import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import type { ApiBlockRule } from '../../src/tools/api/apify_api_blocklist.js';
import { isApiOperationBlocked, validateApiBlocklist } from '../../src/tools/api/apify_api_blocklist.js';
import { normalizeApiPath } from '../../src/tools/api/apify_api_request.js';
import { API_METHODS } from '../../src/tools/api/apify_api_spec.js';

const METHOD_PARAM_REFUSAL =
    'The API tools do not send the method query parameter: the API would take it as the HTTP method of the request.';

const SYNC_RUN_REFUSAL =
    'A GET to the synchronous run endpoints starts a paid run, as a POST does, so the API tools do not send it.';

/** A test-only operation rule. */
const RUN_NOW_RULE: ApiBlockRule = {
    match: { method: 'GET', path: '/v2/actors/{actorId}/run-now' },
    reason: 'No run-now.',
};

/** Validates a GET in a session with no tools, unless the params say otherwise. */
function validate(
    params: Partial<Parameters<typeof validateApiBlocklist>[0]> & { normalizedPath: string },
    rules?: readonly ApiBlockRule[],
): string | undefined {
    return validateApiBlocklist({ method: 'GET', loadedToolNames: [], ...params }, rules);
}

describe('validateApiBlocklist()', () => {
    describe('the method query parameter rule', () => {
        it.each([
            { normalizedPath: 'datasets/abc', query: { method: 'DELETE' } },
            { normalizedPath: 'datasets/abc', query: { METHOD: 'delete' } },
            { normalizedPath: 'datasets/abc', query: { '%6Dethod': 'Delete' } },
            { normalizedPath: 'datasets/abc', query: { 'method[]': 'DELETE' } },
            { normalizedPath: 'datasets/abc', query: { 'method[0]': 'DELETE' } },
            { normalizedPath: 'datasets/abc', query: { 'Method[x]': 'DELETE' } },
            // The API's query parser reads a leading bracket pair as the name.
            { normalizedPath: 'datasets/abc', query: { '[method]': 'DELETE' } },
            { normalizedPath: 'datasets/abc?method=DELETE' },
            { normalizedPath: 'datasets/abc?MeThOd=delete' },
            { normalizedPath: 'datasets/abc?limit=1&%6Dethod=DELETE' },
            { normalizedPath: 'datasets/abc?method%5B%5D=DELETE' },
            { normalizedPath: 'datasets/abc?method[0]=DELETE' },
            { normalizedPath: 'datasets/abc?%5Bmethod%5D=DELETE' },
            { normalizedPath: 'datasets/abc?[METHOD][x]=DELETE' },
            // The URL drops a tab before it is sent.
            { normalizedPath: 'datasets/abc?me\tthod=DELETE' },
        ])('refuses %j in every method', (params) => {
            for (const method of API_METHODS) expect(validate({ ...params, method })).toBe(METHOD_PARAM_REFUSAL);
        });

        it.each([
            { normalizedPath: 'datasets/abc?methods=a&limit=1', query: { methodName: 'b' } },
            { normalizedPath: 'datasets/abc', query: { 'filter[method]': 'b', 'me thod': 'c' } },
            { normalizedPath: 'datasets/abc?x=method', query: { x: 'method' } },
            // A fragment is not sent.
            { normalizedPath: 'datasets/abc#?method=DELETE' },
        ])('does not refuse %j', (params) => {
            expect(validate(params)).toBeUndefined();
        });

        it.each([
            {
                method: 'GET',
                loadedToolNames: [HELPER_TOOLS.API_READ, HELPER_TOOLS.API_WRITE],
                refusal: `${METHOD_PARAM_REFUSAL} Use ${HELPER_TOOLS.API_WRITE} instead.`,
            },
            { method: 'GET', loadedToolNames: [HELPER_TOOLS.API_READ], refusal: METHOD_PARAM_REFUSAL },
            // The write tool sends the PUT, so it is the refusing tool.
            {
                method: 'PUT',
                loadedToolNames: [HELPER_TOOLS.API_READ, HELPER_TOOLS.API_WRITE],
                refusal: METHOD_PARAM_REFUSAL,
            },
        ] as const)(
            'names the write tool only when the session has it and it does not send $method ($loadedToolNames)',
            ({ method, loadedToolNames, refusal }) => {
                expect(validate({ normalizedPath: 'datasets/abc?method=DELETE', method, loadedToolNames })).toBe(
                    refusal,
                );
            },
        );
    });

    describe('an operation rule', () => {
        it.each([
            'actors/abc/run-now',
            'actors/abc/run-now?limit=1',
            // The API routes paths case-insensitively and ignores a trailing slash.
            'Actors/ABC/Run-Now',
            'actors/abc/run-now/',
            // The API routes the legacy acts prefix like actors.
            'acts/john~my-actor/run-now',
            'ACTS/abc/run-now',
            // A slash encoded in a name is decoded after routing, so the name is one segment.
            'actors/apify%2Fhello-world/run-now',
            // The URL is resolved before it is sent: dot segments, a backslash, and a newline.
            'actors/abc/x/../run-now',
            'actors/abc/%2e%2e/abc/run-now',
            'actors\\abc\\run-now',
            'actors/abc/run-\nnow',
            // Escapes in a literal segment are decoded, in case anything before the router decodes them.
            'actors/abc/run%2Dnow',
            // Empty segments are ignored, in case anything before the router merges doubled slashes.
            'actors//abc//run-now',
            'actors/abc/run-now//',
        ])('refuses a GET to %j', (normalizedPath) => {
            expect(validate({ normalizedPath }, [RUN_NOW_RULE])).toBe('No run-now.');
        });

        it.each([
            'actors/abc/run-now-x',
            'actors/run-now',
            'actors//run-now',
            'actors/apify/hello-world/run-now',
            'actor-runs/abc/run-now',
            'actsx/abc/run-now',
            'actors/abc/run-now/x',
        ])('does not refuse a GET to %j', (normalizedPath) => {
            expect(validate({ normalizedPath }, [RUN_NOW_RULE])).toBeUndefined();
        });

        it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
            'does not refuse %s, a method it does not name',
            (method) => {
                expect(validate({ normalizedPath: 'actors/abc/run-now', method }, [RUN_NOW_RULE])).toBeUndefined();
            },
        );

        it('refuses a write method it names', () => {
            const rule: ApiBlockRule = { match: { method: 'DELETE', path: '/v2/actors/{actorId}' }, reason: 'No.' };

            expect(validate({ normalizedPath: 'actors/abc', method: 'DELETE' }, [rule])).toBe('No.');
            expect(validate({ normalizedPath: 'actors/abc', method: 'GET' }, [rule])).toBeUndefined();
        });

        it.each([
            [
                [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.API_WRITE],
                `No run-now. Use ${HELPER_TOOLS.ACTOR_CALL} or ${HELPER_TOOLS.API_WRITE} instead.`,
            ],
            [[HELPER_TOOLS.API_WRITE], `No run-now. Use ${HELPER_TOOLS.API_WRITE} instead.`],
            [[], 'No run-now.'],
        ])('names each suggested tool only when the session has it (%j)', (loadedToolNames, refusal) => {
            const rule: ApiBlockRule = {
                ...RUN_NOW_RULE,
                suggestedToolNames: [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.API_WRITE],
            };

            expect(validate({ normalizedPath: 'actors/abc/run-now', loadedToolNames }, [rule])).toBe(refusal);
        });
    });

    describe('the synchronous run rules', () => {
        it.each([
            'actors/apify~hello-world/run-sync',
            'actors/~my-actor/run-sync-get-dataset-items',
            'actors/HG7ML7M8z78YcAPEB/run-sync',
            'acts/apify~hello-world/run-sync',
            'acts/apify~hello-world/run-sync-get-dataset-items',
            'actor-tasks/john~my-task/run-sync',
            'actor-tasks/HG7ML7M8z78YcAPEB/run-sync-get-dataset-items',
            normalizeApiPath('/v2/actors/abc/run-sync'),
            normalizeApiPath('v2/actor-tasks/abc/run-sync'),
        ])('refuses a GET to %j, not a POST', (normalizedPath) => {
            expect(validate({ normalizedPath })).toBe(SYNC_RUN_REFUSAL);
            expect(validate({ normalizedPath, method: 'POST' })).toBeUndefined();
        });

        it.each([
            'actors/abc/runs',
            'actors/abc/runs/last',
            'actor-tasks/abc/runs',
            'key-value-stores/abc/records/run-sync',
            'actor-runs/abc',
            'actor-runs/abc/run-sync',
            'actors/abc/run-sync-x',
            'actors/run-sync',
            'actors/apify/hello-world/run-sync',
            'datasets/run-sync',
        ])('does not refuse a GET or a POST to %j', (normalizedPath) => {
            expect(validate({ normalizedPath })).toBeUndefined();
            expect(validate({ normalizedPath, method: 'POST' })).toBeUndefined();
        });

        it.each([
            ['actors/abc/run-sync', `Use ${HELPER_TOOLS.ACTOR_CALL} or ${HELPER_TOOLS.API_WRITE}`],
            ['actors/abc/run-sync-get-dataset-items', `Use ${HELPER_TOOLS.ACTOR_CALL} or ${HELPER_TOOLS.API_WRITE}`],
            ['actor-tasks/abc/run-sync', `Use ${HELPER_TOOLS.API_WRITE}`],
            ['actor-tasks/abc/run-sync-get-dataset-items', `Use ${HELPER_TOOLS.API_WRITE}`],
        ])('names the tools to use instead of a GET to %s', (normalizedPath, use) => {
            const loadedToolNames = [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.API_WRITE];

            expect(validate({ normalizedPath, loadedToolNames })).toBe(`${SYNC_RUN_REFUSAL} ${use} instead.`);
        });
    });

    describe('a path outside /v2/', () => {
        const OUTSIDE_V2_REFUSAL =
            'The path leaves /v2/ once its dot segments are resolved; the API tools call only paths under /v2/.';

        it.each([
            '../acts/abc/run-sync',
            '..',
            'x/../../v-experimental/runs',
            '%2e%2e/health',
            '..\\ping',
            '../v2',
            '../v2x/runs',
        ])('refuses %s, whatever the rules', (normalizedPath) => {
            expect(validate({ normalizedPath }, [])).toBe(OUTSIDE_V2_REFUSAL);
        });

        it.each(['actors/abc/../abc/runs', 'x/..', 'datasets/abc', ''])('lets %s through', (normalizedPath) => {
            expect(validate({ normalizedPath }, [])).toBeUndefined();
        });
    });
});

describe('isApiOperationBlocked()', () => {
    it.each([
        { method: 'GET', path: '/v2/actors/{actorId}/run-now', isBlocked: true },
        { method: 'POST', path: '/v2/actors/{actorId}/run-now', isBlocked: false },
        { method: 'GET', path: '/v2/actors/{actorId}/runs', isBlocked: false },
        { method: 'GET', path: '/v2/actors/{actorId}', isBlocked: false },
    ] as const)('returns $isBlocked for $method $path', ({ method, path, isBlocked }) => {
        expect(isApiOperationBlocked(method, path, [RUN_NOW_RULE])).toBe(isBlocked);
    });

    it('matches a literal segment of a rule only to that literal, not to a parameter of the spec', () => {
        const rules: ApiBlockRule[] = [{ match: { method: 'GET', path: '/v2/users/me' }, reason: 'No.' }];

        expect(isApiOperationBlocked('GET', '/v2/users/me', rules)).toBe(true);
        expect(isApiOperationBlocked('GET', '/v2/users/{userId}', rules)).toBe(false);
    });

    it('returns false for a query parameter rule', () => {
        const rules: ApiBlockRule[] = [{ match: { queryParam: 'method' }, reason: 'No.' }];

        expect(isApiOperationBlocked('GET', '/v2/datasets/{datasetId}', rules)).toBe(false);
    });

    it.each([
        '/v2/actors/{actorId}/run-sync',
        '/v2/actors/{actorId}/run-sync-get-dataset-items',
        '/v2/actor-tasks/{actorTaskId}/run-sync',
        '/v2/actor-tasks/{actorTaskId}/run-sync-get-dataset-items',
    ])('blocks the GET of the synchronous run endpoint %s, not the POST', (path) => {
        expect(isApiOperationBlocked('GET', path)).toBe(true);
        expect(isApiOperationBlocked('POST', path)).toBe(false);
    });
});
