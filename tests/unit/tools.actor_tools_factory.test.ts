import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorInfo, SchemaProperties } from '../../src/types.js';
import { only } from './helpers/tool_context.js';

type MockActorOptions = {
    actorPermissionLevel?: string;
    inputProperties?: Record<string, Pick<SchemaProperties, 'type'> & Partial<SchemaProperties>>;
};

function buildInputProperties(inputProperties: MockActorOptions['inputProperties'] = {}) {
    return Object.fromEntries(
        Object.entries(inputProperties).map(([key, property]) => [key, { title: key, description: key, ...property }]),
    );
}

function createMockActorInfo(actorFullName: string, options: MockActorOptions = {}): ActorInfo {
    const { actorPermissionLevel, inputProperties } = options;
    const [username, name] = actorFullName.split('/');
    return {
        webServerMcpPath: null,
        definition: {
            id: 'test-id',
            actorFullName,
            readme: '',
            description: `Test Actor ${actorFullName}`,
            defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300, build: 'latest' },
            input: {
                type: 'object',
                properties: {
                    url: { type: 'string', title: 'URL', description: 'The URL to process' },
                    ...buildInputProperties(inputProperties),
                },
            },
        },
        actor: { id: 'test-actor-id', name, username, actorPermissionLevel } as ActorInfo['actor'],
    };
}

async function getAnnotations(actorInfo: ActorInfo) {
    const [tool] = await getNormalActorsAsTools([actorInfo]);
    return tool.annotations;
}

const LIMITED = { actorPermissionLevel: 'LIMITED_PERMISSIONS' };

describe('getNormalActorsAsTools()', () => {
    describe('annotations', () => {
        it.each(['apify/web-fetch', 'compass/crawler-google-places'])(
            'marks the Apify-maintained Actor %s read-only',
            async (actorFullName) => {
                expect(await getAnnotations(createMockActorInfo(actorFullName, LIMITED))).toMatchObject({
                    readOnlyHint: true,
                    destructiveHint: false,
                    openWorldHint: true,
                });
            },
        );

        it.each<[string, Partial<SchemaProperties>, boolean]>([
            ['a read-only dataset input', { resourceType: 'dataset', resourcePermissions: ['READ'] }, true],
            ['a writable dataset input', { resourceType: 'dataset', resourcePermissions: ['READ', 'WRITE'] }, false],
            [
                'a writable key-value store input',
                { resourceType: 'keyValueStore', resourcePermissions: ['READ', 'WRITE'] },
                false,
            ],
            [
                'a writable request queue input',
                { resourceType: 'requestQueue', resourcePermissions: ['READ', 'WRITE'] },
                false,
            ],
            ['WRITE on a non-storage input', { resourcePermissions: ['WRITE'] }, true],
            ['a secret input', { isSecret: true }, false],
            ['an MCP connector input', { resourceType: 'mcpConnector' }, false],
            ['a JavaScript input', { editor: 'javascript' }, false],
            ['a Python input', { editor: 'python' }, false],
        ])('marks an Actor with %s read-only: %s', async (_, property, isReadOnly) => {
            const actorInfo = createMockActorInfo('apify/web-fetch', {
                ...LIMITED,
                inputProperties: { field: { type: 'string', ...property } },
            });
            expect(await getAnnotations(actorInfo)).toMatchObject({
                readOnlyHint: isReadOnly,
                destructiveHint: !isReadOnly,
            });
        });

        it.each([
            ['a community Actor', createMockActorInfo('someone/web-fetch', LIMITED)],
            [
                'a full-permission Actor',
                createMockActorInfo('apify/web-scraper', { actorPermissionLevel: 'FULL_PERMISSIONS' }),
            ],
            ['an Actor with unknown permissions', createMockActorInfo('apify/web-fetch')],
            ['an Apify-maintained Actor that sends email', createMockActorInfo('apify/send-mail', LIMITED)],
        ])('keeps %s destructive', async (_, actorInfo) => {
            expect(await getAnnotations(actorInfo)).toMatchObject({
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            });
        });
    });

    // Regression: #1532 — the RAG description recommended Store Actors and a web-fetch tool the session might not have.
    describe('apify/rag-web-browser description', () => {
        const STORE_ACTOR_HINT =
            'For repeated/scheduled scraping of specific platforms (e-commerce, social media), consider suggesting a specialized Actor from the Store for better performance and reliability.';
        const WEB_FETCH_HINT =
            "When the user provides one specific URL and wants that page's full or verbatim content, prefer the dedicated apify/web-fetch tool when it is available - this tool is for searching and scraping by query.";
        const GENERAL_SCRAPING = 'This is for general web scraping and immediate data needs.';
        const RAG_TOOL = actorNameToToolName(RAG_WEB_BROWSER);
        const WEB_FETCH_TOOL = actorNameToToolName(WEB_FETCH);

        async function renderRagDescription(...present: string[]) {
            const [tool] = await getNormalActorsAsTools([createMockActorInfo(RAG_WEB_BROWSER)]);
            return tool.buildDescription!(only(RAG_TOOL, ...present));
        }

        it('keeps both hints when a general runner and apify/web-fetch are served', async () => {
            const description = await renderRagDescription(HELPER_TOOLS.ACTOR_CALL, WEB_FETCH_TOOL);
            expect(description).toContain(`${GENERAL_SCRAPING} ${STORE_ACTOR_HINT}\n${WEB_FETCH_HINT}`);
        });

        it('omits the Store Actor hint when no tool can run an Actor', async () => {
            const description = await renderRagDescription(WEB_FETCH_TOOL);
            expect(description).toContain(`${GENERAL_SCRAPING}\n${WEB_FETCH_HINT}`);
            expect(description).not.toContain(STORE_ACTOR_HINT);
        });

        it.each([[HELPER_TOOLS.ACTOR_CALL], [HELPER_TOOLS.ACTOR_CALL_WIDGET], [HELPER_TOOLS.API_WRITE]])(
            'names apify/web-fetch only when its tool is served, with %s',
            async (runner) => {
                const description = await renderRagDescription(runner);
                expect(description).toContain(`${GENERAL_SCRAPING} ${STORE_ACTOR_HINT}`);
                expect(description).not.toContain('web-fetch');
            },
        );

        it('keeps the general-scraping sentence and the Actor description with neither', async () => {
            const description = await renderRagDescription();
            expect(description.endsWith(GENERAL_SCRAPING)).toBe(true);
            expect(description).toContain(
                `This tool calls the Actor "${RAG_WEB_BROWSER}" and retrieves its output results.`,
            );
            expect(description).not.toContain(STORE_ACTOR_HINT);
            expect(description).not.toContain('web-fetch');
        });

        it('keeps the all-tools description on both hints', async () => {
            const [tool] = await getNormalActorsAsTools([createMockActorInfo(RAG_WEB_BROWSER)]);
            expect(tool.description?.endsWith(`${GENERAL_SCRAPING} ${STORE_ACTOR_HINT}\n${WEB_FETCH_HINT}`)).toBe(true);
        });
    });
});
