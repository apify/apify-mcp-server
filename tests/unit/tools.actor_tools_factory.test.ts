import { describe, expect, it } from 'vitest';

import { RAG_WEB_BROWSER, WEB_FETCH, WEB_SEARCH } from '../../src/const.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorInfo, SchemaProperties } from '../../src/types.js';
import { getToolPublicFieldOnly } from '../../src/utils/tools.js';

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

    describe('direct Actor contract', () => {
        const actorInfo = createMockActorInfo('apify/website-content-crawler', {
            ...LIMITED,
            inputProperties: {
                respectRobotsTxtFile: { type: 'boolean', default: false },
                pageFunction: { type: 'string', editor: 'hidden', default: '' },
                initialCookies: { type: 'array', editor: 'json', isSecret: true },
            },
        });

        it('serves restricted inputs and derives read-only annotations without changing the source', async () => {
            const original = structuredClone(actorInfo);
            const [tool] = await getNormalActorsAsTools([actorInfo]);
            expect(tool.inputSchema.properties).not.toHaveProperty('pageFunction');
            expect(tool.inputSchema.properties).not.toHaveProperty('initialCookies');
            expect(tool.inputSchema.properties?.respectRobotsTxtFile).toMatchObject({ default: true });
            expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
            expect(tool.description).toContain('pageFunction');
            expect(tool.description).toContain('initialCookies');
            expect(actorInfo).toEqual(original);
        });

        it('serves a plain object schema without composition keywords', async () => {
            // OpenAI rejects a function schema with allOf/anyOf/oneOf/not at the top level, strict or not.
            const [tool] = await getNormalActorsAsTools([actorInfo]);
            for (const keyword of ['allOf', 'anyOf', 'oneOf', 'not'])
                expect(tool.inputSchema).not.toHaveProperty(keyword);
            expect(tool.ajvValidate({ url: 'https://example.com', respectRobotsTxtFile: false })).toBe(true);
        });

        it('removes denied fields from required', async () => {
            const info = structuredClone(actorInfo);
            info.definition.input!.required = ['url', 'initialCookies'];
            const [tool] = await getNormalActorsAsTools([info]);
            expect(tool.inputSchema.required).toEqual(['url']);
            expect(tool.ajvValidate({ url: 'https://example.com' })).toBe(true);
        });

        it('retains permission checks and other secret inputs', async () => {
            const fullPermissions = structuredClone(actorInfo);
            fullPermissions.actor.actorPermissionLevel = 'FULL_PERMISSIONS';
            const otherSecret = structuredClone(actorInfo);
            otherSecret.definition.input!.properties.password = {
                type: 'string',
                title: 'Password',
                description: 'Password',
                isSecret: true,
            };
            for (const info of [fullPermissions, otherSecret]) {
                expect(await getAnnotations(info)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
            }
        });
    });

    describe('existing Actor presentation policies', () => {
        it.each([true, false])('preserves RAG exposure and validation with isDirectTool %s', async (isDirectTool) => {
            const actorInfo = createMockActorInfo(RAG_WEB_BROWSER, {
                ...LIMITED,
                inputProperties: {
                    query: { type: 'string' },
                    maxResults: { type: 'integer', default: 3 },
                    outputFormats: { type: 'array', default: ['markdown'] },
                    hiddenSecret: { type: 'string', isSecret: true },
                },
                inputRequired: ['query', 'maxResults'],
            });
            const original = structuredClone(actorInfo);
            const [tool] = await getNormalActorsAsTools([actorInfo], { isDirectTool });
            expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([
                'query',
                'maxResults',
                'outputFormats',
                'waitSecs',
            ]);
            expect(tool.inputSchema.required).toEqual(['query']);
            const input = { query: 'apify', hiddenSecret: 'original-input' };
            expect(tool.ajvValidate(input)).toBe(true);
            expect(input).toEqual({ query: 'apify', hiddenSecret: 'original-input' });
            expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
            expect(actorInfo).toEqual(original);
        });

        it('describes Web Search results without page content or sibling referrals', async () => {
            const [tool] = await getNormalActorsAsTools([createMockActorInfo(WEB_SEARCH)]);

            expect(tool.description).toContain('one page of organic results');
            expect(tool.description).toContain('title, URL, snippet and position');
            expect(tool.description).toContain('no page content');
            expect(tool.description).not.toContain(WEB_FETCH);
            expect(tool.description).not.toContain(RAG_WEB_BROWSER);
        });

        it.each([true, false])('preserves Web Fetch descriptions with isDirectTool %s', async (isDirectTool) => {
            const actorInfo = createMockActorInfo(WEB_FETCH, { ...LIMITED });
            const original = structuredClone(actorInfo);
            const [tool] = await getNormalActorsAsTools([actorInfo], { isDirectTool });
            expect(tool.description).toContain('Use this tool to fetch a specific http(s) URL');
            expect(tool.inputSchema.properties?.url).toMatchObject({
                description:
                    'The URL to process http(s) URLs only - for any other scheme (e.g. ftp:), tell the user this tool cannot fetch it rather than substituting a different URL.',
            });
            expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
            expect(actorInfo).toEqual(original);
        });
    });

    it('describes RAG page content without referring to Web Fetch', async () => {
        const [tool] = await getNormalActorsAsTools([createMockActorInfo(RAG_WEB_BROWSER)]);
        const alone = getToolPublicFieldOnly(tool, { presentTools: new Set([tool.name]) }).description;
        const together = getToolPublicFieldOnly(tool, {
            presentTools: new Set([tool.name, actorNameToToolName(WEB_FETCH)]),
        }).description;

        expect(together).toBe(alone);
        expect(together).toContain('text of the top results');
        expect(together).not.toContain(WEB_FETCH);
    });
});
