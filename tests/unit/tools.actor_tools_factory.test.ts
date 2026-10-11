import { describe, expect, it } from 'vitest';

import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorInfo, SchemaProperties } from '../../src/types.js';

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
});
