import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaults, HelperTools } from '../../src/const.js';
import { defaultTools } from '../../src/tools/index.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import type { MCPClientOptions } from '../helpers';

interface IntegrationTestsSuiteOptions {
    suiteName: string;
    createClientFn: (options?: MCPClientOptions) => Promise<Client>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
}

function expectToolNamesToContain(names: string[], actors: string[] = []) {
    expect(names.length).toEqual(defaultTools.length + actors.length);
    for (const tool of defaultTools) {
        expect(names).toContain(tool.tool.name);
    }
    for (const actor of actors) {
        expect(names).toContain(actorNameToToolName(actor));
    }
}

async function callPythonExampleActor(client: Client, selectedToolName: string) {
    const result = await client.callTool({
        name: selectedToolName,
        arguments: {
            first_number: 1,
            second_number: 2,
        },
    });

    type ContentItem = { text: string; type: string };
    const content = result.content as ContentItem[];
    // The result is { content: [ ... ] }, and the last content is the sum
    expect(content[content.length - 1]).toEqual({
        text: JSON.stringify({
            first_number: 1,
            second_number: 2,
            sum: 3,
        }),
        type: 'text',
    });
}

export function createIntegrationTestsSuite(
    options: IntegrationTestsSuiteOptions,
) {
    const {
        suiteName,
        createClientFn,
        beforeAllFn,
        afterAllFn,
        beforeEachFn,
        afterEachFn,
    } = options;

    // Hooks
    if (beforeAllFn) {
        beforeAll(beforeAllFn);
    }
    if (afterAllFn) {
        afterAll(afterAllFn);
    }
    if (beforeEachFn) {
        beforeEach(beforeEachFn);
    }
    if (afterEachFn) {
        afterEach(afterEachFn);
    }

    describe(suiteName, () => {
        it('list default tools', async () => {
            const client = await createClientFn();
            const tools = await client.listTools();
            const names = tools.tools.map((tool) => tool.name);

            expectToolNamesToContain(names, defaults.actors);

            await client.close();
        });

        it('use only apify/python-example Actor and call it', async () => {
            const actors = ['apify/python-example'];
            const client = await createClientFn({
                actors,
                enableAddingActors: false,
            });
            const tools = await client.listTools();
            const names = tools.tools.map((tool) => tool.name);
            expectToolNamesToContain(names, actors);

            const selectedToolName = actorNameToToolName(actors[0]);
            expect(names).toContain(selectedToolName);

            await callPythonExampleActor(client, selectedToolName);

            await client.close();
        });

        it('load Actors from parameters', async () => {
            const actors = ['apify/rag-web-browser', 'apify/instagram-scraper'];
            const client = await createClientFn({
                actors,
                enableAddingActors: false,
            });
            const tools = await client.listTools();
            const names = tools.tools.map((tool) => tool.name);
            expectToolNamesToContain(names, actors);

            await client.close();
        });

        it('load Actor dynamically and call it', async () => {
            const actor = 'apify/python-example';
            const selectedToolName = actorNameToToolName(actor);
            const client = await createClientFn({
                enableAddingActors: true,
            });
            const tools = await client.listTools();
            const names = tools.tools.map((tool) => tool.name);
            expect(names.length).toEqual(defaultTools.length + defaults.actorAddingTools.length + defaults.actors.length);
            for (const tool of defaultTools) {
                expect(names).toContain(tool.tool.name);
            }
            for (const tool of defaults.actorAddingTools) {
                expect(names).toContain(tool);
            }
            for (const actorTool of defaults.actors) {
                expect(names).toContain(actorNameToToolName(actorTool));
            }

            // Add Actor dynamically
            await client.callTool({
                name: HelperTools.ACTOR_ADD,
                arguments: {
                    actorName: actor,
                },
            });

            // Check if tools was added
            const toolsAfterAdd = await client.listTools();
            const namesAfterAdd = toolsAfterAdd.tools.map((tool) => tool.name);
            expect(namesAfterAdd.length).toEqual(defaultTools.length + defaults.actorAddingTools.length + defaults.actors.length + 1);
            expect(namesAfterAdd).toContain(selectedToolName);

            await callPythonExampleActor(client, selectedToolName);

            await client.close();
        });

        it('should remove Actor from tools list', async () => {
            const actor = 'apify/python-example';
            const selectedToolName = actorNameToToolName(actor);
            const client = await createClientFn({
                actors: [actor],
                enableAddingActors: true,
            });

            // Verify actor is in the tools list
            const toolsBefore = await client.listTools();
            const namesBefore = toolsBefore.tools.map((tool) => tool.name);
            expect(namesBefore).toContain(selectedToolName);

            // Remove the actor
            await client.callTool({
                name: HelperTools.ACTOR_REMOVE,
                arguments: {
                    toolName: selectedToolName,
                },
            });

            // Verify actor is removed
            const toolsAfter = await client.listTools();
            const namesAfter = toolsAfter.tools.map((tool) => tool.name);
            expect(namesAfter).not.toContain(selectedToolName);

            await client.close();
        });
    });
}
