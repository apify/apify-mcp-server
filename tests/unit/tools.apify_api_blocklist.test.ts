import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import type { ApiBlockRule } from '../../src/tools/api/apify_api_blocklist.js';
import { validateApiBlocklist, validateApiPathBlocklist } from '../../src/tools/api/apify_api_blocklist.js';
import { normalizeApiPath } from '../../src/tools/api/apify_api_request.js';

const METHOD_PARAM_REFUSAL =
    'The API tools do not send the method query parameter: the API would take it as the HTTP method of the request.';

const SYNC_RUN_REFUSAL =
    'A GET to the synchronous run endpoints starts a paid run, as a POST does, so the API tools do not send it.';

/** A test-only operation rule. */
const OPERATION_RULE: ApiBlockRule = {
    operation: { methods: ['GET'], path: '/v2/actors/{actorId}/run-now' },
    reason: 'No run-now.',
};

/** Validates a GET from the read tool in a session with no other tools, unless the params say otherwise. */
function validate(
    params: Partial<Parameters<typeof validateApiBlocklist>[0]> & { normalizedPath: string },
    rules?: readonly ApiBlockRule[],
): string | undefined {
    return validateApiBlocklist(
        { toolName: HELPER_TOOLS.API_READ, method: 'GET', loadedToolNames: [], ...params },
        rules,
    );
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
        ])('refuses %j in both call tools', (params) => {
            expect(validate(params)).toBe(METHOD_PARAM_REFUSAL);
            expect(validate({ ...params, toolName: HELPER_TOOLS.API_WRITE, method: 'PUT' })).toBe(METHOD_PARAM_REFUSAL);
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

        it('checks the query names without the method, before the write tool chooses one', () => {
            expect(
                validate({
                    toolName: HELPER_TOOLS.API_WRITE,
                    method: undefined,
                    normalizedPath: 'datasets/abc?method=PUT',
                }),
            ).toBe(METHOD_PARAM_REFUSAL);
        });
    });

    it('names the suggested tool only when the session has it and it is not the refusing tool', () => {
        const params = { normalizedPath: 'datasets/abc', query: { method: 'DELETE' } };

        expect(validate({ ...params, loadedToolNames: [HELPER_TOOLS.API_READ, HELPER_TOOLS.API_WRITE] })).toBe(
            `${METHOD_PARAM_REFUSAL} Use ${HELPER_TOOLS.API_WRITE} instead.`,
        );
        expect(validate({ ...params, loadedToolNames: [HELPER_TOOLS.API_READ] })).toBe(METHOD_PARAM_REFUSAL);
        expect(
            validate({
                ...params,
                toolName: HELPER_TOOLS.API_WRITE,
                method: 'PUT',
                loadedToolNames: [HELPER_TOOLS.API_READ, HELPER_TOOLS.API_WRITE],
            }),
        ).toBe(METHOD_PARAM_REFUSAL);
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
        ])('refuses the method and path template it names for %j', (normalizedPath) => {
            expect(validate({ normalizedPath }, [OPERATION_RULE])).toBe('No run-now.');
        });

        it.each([
            'actors/abc/run-now-x',
            'actors/run-now',
            'actors//run-now',
            'actors/apify/hello-world/run-now',
            'actor-runs/abc/run-now',
            'actsx/abc/run-now',
            'actors/abc/run-now/x',
        ])('does not refuse %j', (normalizedPath) => {
            expect(validate({ normalizedPath }, [OPERATION_RULE])).toBeUndefined();
        });

        it('refuses each method it names in the tool that sends that method, and no other method', () => {
            const rule: ApiBlockRule = {
                operation: { methods: ['GET', 'DELETE'], path: '/v2/actors/{actorId}/run-now' },
                reason: 'No run-now.',
            };
            const normalizedPath = 'actors/abc/run-now';
            const write = { normalizedPath, toolName: HELPER_TOOLS.API_WRITE };

            expect(validate({ normalizedPath }, [rule])).toBe('No run-now.');
            expect(validate({ ...write, method: 'DELETE' }, [rule])).toBe('No run-now.');
            expect(validate({ ...write, method: 'POST' }, [rule])).toBeUndefined();
        });

        it('refuses the path in any method when the method is not chosen yet, in a tool that sends one it names', () => {
            const normalizedPath = 'actors/abc/run-now';

            expect(validate({ normalizedPath, method: undefined }, [OPERATION_RULE])).toBe('No run-now.');
            // The write tool never sends the rule's GET.
            expect(
                validate({ normalizedPath, toolName: HELPER_TOOLS.API_WRITE, method: undefined }, [OPERATION_RULE]),
            ).toBeUndefined();
        });

        it('names the suggested tool only when the session has it', () => {
            const rule: ApiBlockRule = { ...OPERATION_RULE, suggestedToolNames: [HELPER_TOOLS.ACTOR_CALL] };
            const normalizedPath = 'actors/abc/run-now';

            expect(validate({ normalizedPath, loadedToolNames: [HELPER_TOOLS.ACTOR_CALL] }, [rule])).toBe(
                `No run-now. Use ${HELPER_TOOLS.ACTOR_CALL} instead.`,
            );
            expect(validate({ normalizedPath }, [rule])).toBe('No run-now.');
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
            // A slash encoded in a name is decoded after routing, so the name is one segment.
            'actors/apify%2Fhello-world/run-sync',
            'ACTORS/APIFY~HELLO-WORLD/RUN-SYNC',
            'Actor-Tasks/abc/Run-Sync-Get-Dataset-Items',
            'actors/abc/run-sync/',
            'actors//abc//run-sync',
            'actors/abc/run-sync?timeout=300&token=x',
            normalizeApiPath('/v2/actors/abc/run-sync'),
            normalizeApiPath('v2/actor-tasks/abc/run-sync'),
        ])('refuses a GET to %j in the read tool, not a POST in the write tool', (normalizedPath) => {
            expect(validate({ normalizedPath })).toBe(SYNC_RUN_REFUSAL);
            expect(validate({ normalizedPath, toolName: HELPER_TOOLS.API_WRITE, method: 'POST' })).toBeUndefined();
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
        ])('does not refuse %j', (normalizedPath) => {
            expect(validate({ normalizedPath })).toBeUndefined();
            expect(validate({ normalizedPath, toolName: HELPER_TOOLS.API_WRITE, method: 'POST' })).toBeUndefined();
        });

        it('does not refuse the write tool without a method, since it never sends the GET', () => {
            expect(
                validate({
                    normalizedPath: 'actors/abc/run-sync',
                    toolName: HELPER_TOOLS.API_WRITE,
                    method: undefined,
                }),
            ).toBeUndefined();
        });

        it.each([
            [
                [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.API_WRITE],
                `Use ${HELPER_TOOLS.ACTOR_CALL} or ${HELPER_TOOLS.API_WRITE}`,
            ],
            [[HELPER_TOOLS.ACTOR_CALL], `Use ${HELPER_TOOLS.ACTOR_CALL}`],
            [[HELPER_TOOLS.API_WRITE], `Use ${HELPER_TOOLS.API_WRITE}`],
        ])(
            'names for an Actor call-actor and the write tool, each only when the session has it (%j)',
            (loadedToolNames, use) => {
                expect(validate({ normalizedPath: 'actors/abc/run-sync', loadedToolNames })).toBe(
                    `${SYNC_RUN_REFUSAL} ${use} instead.`,
                );
                expect(validate({ normalizedPath: 'acts/abc/run-sync-get-dataset-items', loadedToolNames })).toBe(
                    `${SYNC_RUN_REFUSAL} ${use} instead.`,
                );
            },
        );

        it('names for a task only the write tool, since call-actor cannot run a saved task', () => {
            const loadedToolNames = [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.API_WRITE];
            const withWriteTool = `${SYNC_RUN_REFUSAL} Use ${HELPER_TOOLS.API_WRITE} instead.`;

            expect(validate({ normalizedPath: 'actor-tasks/abc/run-sync', loadedToolNames })).toBe(withWriteTool);
            expect(validate({ normalizedPath: 'actor-tasks/abc/run-sync-get-dataset-items', loadedToolNames })).toBe(
                withWriteTool,
            );
            expect(
                validate({ normalizedPath: 'actor-tasks/abc/run-sync', loadedToolNames: [HELPER_TOOLS.ACTOR_CALL] }),
            ).toBe(SYNC_RUN_REFUSAL);
        });
    });
});

describe('validateApiPathBlocklist()', () => {
    it.each([
        {
            normalizedPath: 'actors/abc/run-sync',
            refusal: `${SYNC_RUN_REFUSAL} Use ${HELPER_TOOLS.ACTOR_CALL} instead.`,
        },
        { normalizedPath: 'actor-tasks/{actorTaskId}/run-sync-get-dataset-items', refusal: SYNC_RUN_REFUSAL },
    ])('refuses $normalizedPath, a path a rule refuses in any tool', ({ normalizedPath, refusal }) => {
        expect(validateApiPathBlocklist({ normalizedPath, loadedToolNames: [HELPER_TOOLS.ACTOR_CALL] })).toBe(refusal);
    });

    it('refuses only the methods a rule names when a method is given', () => {
        const normalizedPath = 'actors/abc/run-sync';

        expect(validateApiPathBlocklist({ normalizedPath, method: 'GET', loadedToolNames: [] })).toBe(SYNC_RUN_REFUSAL);
        expect(validateApiPathBlocklist({ normalizedPath, method: 'POST', loadedToolNames: [] })).toBeUndefined();
    });

    it('checks only the operation rules', () => {
        expect(validateApiPathBlocklist({ normalizedPath: 'actors/abc/runs', loadedToolNames: [] })).toBeUndefined();
        expect(
            validateApiPathBlocklist({ normalizedPath: 'not-in-spec?method=DELETE', loadedToolNames: [] }),
        ).toBeUndefined();
    });
});
