import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import type { ApiBlockRule } from '../../src/tools/api/apify_api_blocklist.js';
import { validateApiBlocklist } from '../../src/tools/api/apify_api_blocklist.js';

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
            const rule: ApiBlockRule = { ...OPERATION_RULE, suggestedToolName: HELPER_TOOLS.ACTOR_CALL };
            const normalizedPath = 'actors/abc/run-now';

            expect(validate({ normalizedPath, loadedToolNames: [HELPER_TOOLS.ACTOR_CALL] }, [rule])).toBe(
                `No run-now. Use ${HELPER_TOOLS.ACTOR_CALL} instead.`,
            );
            expect(validate({ normalizedPath }, [rule])).toBe('No run-now.');
        });
    });
});
