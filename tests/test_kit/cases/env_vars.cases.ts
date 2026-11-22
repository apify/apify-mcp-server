import { ActorSourceType } from 'apify-client';
import { expect } from 'vitest';

import { validateStructuredOutputForTool, withClient } from '../helpers.js';
import type { Case } from '../types.js';

/**
 * The env-vars tools against the live API. Each case seeds its own Actor with the raw client and deletes it by name in
 * `finally`; apify-client swallows the 404 when there is none.
 *
 * Names are `test-env-vars-<random>-<purpose>`, never `eval-`, so the eval harness's `eval-*` sweep on the same
 * account never deletes an Actor mid-case.
 *
 * Tool names are hardcoded, not read from `HELPER_TOOLS`, so a rename fails these tests (CONTRIBUTING.md).
 */

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };

/** Unique per call: three transport dimensions register each case, and CI runs PRs concurrently in one account. */
function buildUniqueActorName(purpose: string): string {
    return `test-env-vars-${Math.random().toString(36).slice(2, 8)}-${purpose}`;
}

export const envVarsCases: Case[] = [
    {
        name: 'get-actor-env-var-list returns the names, secrecy, and plain values of a version, never a secret value or a value hash',
        isDeploymentTest: false,
        run: withClient({ tools: ['env-vars'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('list');
            const { username } = await api.user().get();
            const selector = `${username}~${name}`;
            const secretValue = `secret-${Math.random().toString(36).slice(2)}`;
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [
                        {
                            versionNumber: '0.0',
                            sourceType: ActorSourceType.SourceFiles,
                            envVars: [
                                { name: 'MODE', value: 'test' },
                                { name: 'API_KEY', value: secretValue, isSecret: true },
                            ],
                            sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("env");\n' }],
                        },
                    ],
                });

                const result = (await client.callTool({
                    name: 'get-actor-env-var-list',
                    arguments: { actor: selector },
                })) as ToolCallResult;

                expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
                validateStructuredOutputForTool(result, 'get-actor-env-var-list', 'default');
                expect(JSON.parse(result.content?.[0]?.text ?? 'null')).toEqual(result.structuredContent);
                const listed = result.structuredContent as { envVars: { name: string }[] };
                expect({
                    ...listed,
                    envVars: [...listed.envVars].sort((a, b) => (a.name < b.name ? -1 : 1)),
                }).toEqual({
                    actorId: seeded.id,
                    fullName: `${username}/${name}`,
                    versionNumber: '0.0',
                    envVars: [
                        { name: 'API_KEY', isSecret: true },
                        { name: 'MODE', isSecret: false, value: 'test' },
                    ],
                });
                const serialized = JSON.stringify(result);
                expect(serialized).not.toContain(secretValue);
                expect(serialized).not.toContain('valueHash');
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
];
