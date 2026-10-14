import { describe, expect, it } from 'vitest';

import { RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorInfo, SchemaProperties } from '../../src/types.js';
import { getToolPublicFieldOnly } from '../../src/utils/tools.js';
import { only } from './helpers/tool_context.js';

type MockActorOptions = {
    actorPermissionLevel?: string;
    inputProperties?: Record<string, Pick<SchemaProperties, 'type'> & Partial<SchemaProperties>>;
    inputRequired?: string[];
};

function buildInputProperties(inputProperties: MockActorOptions['inputProperties'] = {}) {
    return Object.fromEntries(
        Object.entries(inputProperties).map(([key, property]) => [key, { title: key, description: key, ...property }]),
    );
}

function createMockActorInfo(actorFullName: string, options: MockActorOptions = {}): ActorInfo {
    const { actorPermissionLevel, inputProperties, inputRequired } = options;
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
                required: inputRequired,
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
    // Regression: #1513 — the validator required a property the platform fills from its default.
    describe('input validation', () => {
        const actorInfo = createMockActorInfo('apify/screenshot-url', {
            inputProperties: {
                delay: { type: 'integer', default: 0 },
                waitUntil: { type: 'string', enum: ['load', 'networkidle2'] },
                mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
                proxy: { type: 'object', editor: 'proxy', default: { useApifyProxy: true } },
            },
            inputRequired: ['url', 'delay', 'waitUntil', 'mode', 'proxy'],
        });

        it('accepts a call that omits a required property with a default', async () => {
            const upstream = structuredClone(actorInfo);
            const [tool] = await getNormalActorsAsTools([actorInfo]);
            const args = { url: 'https://example.com', waitUntil: 'load' };

            expect(tool.ajvValidate(args)).toBe(true);
            expect(args).toEqual({ url: 'https://example.com', waitUntil: 'load' });
            expect(actorInfo).toEqual(upstream);
            expect(tool.inputSchema.required).toEqual(['url', 'waitUntil']);
            expect(getToolPublicFieldOnly(tool).inputSchema.required).toEqual(tool.inputSchema.required);
        });

        it.each<[string, Partial<SchemaProperties>, boolean]>([
            ['zero', { type: 'integer', default: 0, prefill: 100 }, true],
            ['false', { type: 'boolean', default: false }, true],
            ['null', { type: 'string', default: null }, true],
            ['empty string', { type: 'string', default: '' }, true],
            ['empty array', { type: 'array', default: [] }, true],
            ['empty object', { type: 'object', default: {} }, true],
            ['undefined', { type: 'string', default: undefined }, false],
            ['prefill only', { type: 'string', prefill: 'example' }, false],
        ])('validates omission with %s through the compiled Actor tool', async (_label, property, isValid) => {
            const [tool] = await getNormalActorsAsTools([
                createMockActorInfo('someone/defaults', {
                    inputProperties: { value: { type: 'string', ...property } },
                    inputRequired: ['value'],
                }),
            ]);
            const args = {};

            expect(tool.ajvValidate(args)).toBe(isValid);
            expect(args).toEqual({});
        });

        it('validates supplied nested objects instead of filling their missing fields', async () => {
            const [tool] = await getNormalActorsAsTools([
                createMockActorInfo('someone/nested-defaults', {
                    inputProperties: {
                        settings: {
                            type: 'object',
                            default: { mode: 'a' },
                            properties: buildInputProperties({ mode: { type: 'string', default: 'a' } }),
                            required: ['mode'],
                        },
                    },
                    inputRequired: ['settings'],
                }),
            ]);

            expect(tool.ajvValidate({})).toBe(true);
            expect(tool.ajvValidate({ settings: {} })).toBe(false);
            expect(tool.ajvValidate({ settings: { mode: 'b' } })).toBe(true);
        });

        it('rejects a call that omits a required property without a default', async () => {
            const [tool] = await getNormalActorsAsTools([actorInfo]);

            expect(tool.ajvValidate({ url: 'https://example.com' })).toBe(false);
            expect(tool.ajvValidate({ waitUntil: 'load' })).toBe(false);
        });

        it('rejects supplied defaulted properties of the wrong type or outside the enum', async () => {
            const [tool] = await getNormalActorsAsTools([actorInfo]);

            expect(tool.ajvValidate({ url: 'https://example.com', waitUntil: 'load', delay: 'soon' })).toBe(false);
            expect(tool.ajvValidate({ url: 'https://example.com', waitUntil: 'load', mode: 'c' })).toBe(false);
            expect(tool.ajvValidate({ url: 'https://example.com', waitUntil: 'load', proxy: 'not-an-object' })).toBe(
                false,
            );
        });
    });

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

        // Its secret initialCookies input authenticates the crawl of the sites it reads (#1575).
        it('marks apify/website-content-crawler read-only despite its secret input', async () => {
            const actorInfo = createMockActorInfo('apify/website-content-crawler', {
                ...LIMITED,
                inputProperties: { initialCookies: { type: 'array', editor: 'json', isSecret: true } },
            });
            expect(await getAnnotations(actorInfo)).toMatchObject({
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: true,
            });
        });

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
            [
                'a community Actor named website-content-crawler with a secret input',
                createMockActorInfo('someone/website-content-crawler', {
                    ...LIMITED,
                    inputProperties: { initialCookies: { type: 'array', isSecret: true } },
                }),
            ],
            [
                'apify/website-content-crawler with another secret input',
                createMockActorInfo('apify/website-content-crawler', {
                    ...LIMITED,
                    inputProperties: {
                        initialCookies: { type: 'array', isSecret: true },
                        apiKey: { type: 'string', isSecret: true },
                    },
                }),
            ],
            [
                'apify/website-content-crawler with a writable dataset input',
                createMockActorInfo('apify/website-content-crawler', {
                    ...LIMITED,
                    inputProperties: {
                        initialCookies: { type: 'array', isSecret: true },
                        output: { type: 'string', resourceType: 'dataset', resourcePermissions: ['READ', 'WRITE'] },
                    },
                }),
            ],
        ])('keeps %s destructive', async (_, actorInfo) => {
            expect(await getAnnotations(actorInfo)).toMatchObject({
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            });
        });
    });

    // The read-only website-content-crawler tool offers no page code (#1575); the Actor itself still accepts it.
    it('omits pageFunction only from the apify/website-content-crawler tool', async () => {
        const pageFunction = { type: 'string', editor: 'hidden' } as const;
        const [crawler, other] = await getNormalActorsAsTools([
            createMockActorInfo('apify/website-content-crawler', { inputProperties: { pageFunction } }),
            createMockActorInfo('apify/web-scraper', { inputProperties: { pageFunction } }),
        ]);

        expect(getToolPublicFieldOnly(crawler).inputSchema.properties).not.toHaveProperty('pageFunction');
        expect(crawler.inputSchema.properties).toHaveProperty('url');
        expect(other.inputSchema.properties).toHaveProperty('pageFunction');
    });

    // Regression: #1532 — the RAG description named apify/web-fetch when the session did not serve it.
    it('names apify/web-fetch in the RAG description only when its tool is served', async () => {
        const [tool] = await getNormalActorsAsTools([createMockActorInfo(RAG_WEB_BROWSER)]);
        const ragTool = actorNameToToolName(RAG_WEB_BROWSER);
        expect(tool.buildDescription!(only(ragTool, actorNameToToolName(WEB_FETCH)))).toContain(
            'prefer the dedicated apify/web-fetch tool',
        );
        expect(tool.buildDescription!(only(ragTool))).not.toContain('web-fetch');
    });
});
