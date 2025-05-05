import { describe, expect, it } from 'vitest';

import { defaults, HelperTools } from '../../src/const.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import { createMCPStdioClient } from '../helpers.js';

describe('MCP STDIO', () => {
    it('list default tools', async () => {
        const client = await createMCPStdioClient();
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);

        expect(names.length).toEqual(defaults.actors.length + defaults.helperTools.length);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        for (const actor of defaults.actors) {
            expect(names).toContain(actorNameToToolName(actor));
        }
        await client.close();
    });

    it('use only apify/python-example Actor and call it', async () => {
        const actorName = 'apify/python-example';
        const selectedToolName = actorNameToToolName(actorName);
        const client = await createMCPStdioClient({
            actors: [actorName],
            enableAddingActors: false,
        });
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names.length).toEqual(defaults.helperTools.length + 1);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        expect(names).toContain(selectedToolName);

        const result = await client.callTool({
            name: selectedToolName,
            arguments: {
                first_number: 1,
                second_number: 2,
            },
        });

        expect(result).toEqual({
            content: [{
                text: JSON.stringify({
                    first_number: 1,
                    second_number: 2,
                    sum: 3,
                }),
                type: 'text',
            }],
        });

        await client.close();
    });

    it('load Actors from parameters', async () => {
        const actors = ['apify/rag-web-browser', 'apify/instagram-scraper'];
        const client = await createMCPStdioClient({
            actors,
            enableAddingActors: false,
        });
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names.length).toEqual(defaults.helperTools.length + actors.length);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        for (const actor of actors) {
            expect(names).toContain(actorNameToToolName(actor));
        }

        await client.close();
    });

    it('load Actor dynamically and call it', async () => {
        const actor = 'apify/python-example';
        const selectedToolName = actorNameToToolName(actor);
        const client = await createMCPStdioClient({
            enableAddingActors: true,
        });
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names.length).toEqual(defaults.helperTools.length + defaults.actorAddingTools.length + defaults.actors.length);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        for (const tool of defaults.actorAddingTools) {
            expect(names).toContain(tool);
        }
        for (const actorTool of defaults.actors) {
            expect(names).toContain(actorNameToToolName(actorTool));
        }

        // Add Actor dynamically
        await client.callTool({
            name: HelperTools.ADD_ACTOR,
            arguments: {
                actorName: actor,
            },
        });

        // Check if tools was added
        const toolsAfterAdd = await client.listTools();
        const namesAfterAdd = toolsAfterAdd.tools.map((tool) => tool.name);
        expect(namesAfterAdd.length).toEqual(defaults.helperTools.length + defaults.actorAddingTools.length + defaults.actors.length + 1);
        expect(namesAfterAdd).toContain(selectedToolName);

        const result = await client.callTool({
            name: selectedToolName,
            arguments: {
                first_number: 1,
                second_number: 2,
            },
        });

        expect(result).toEqual({
            content: [{
                text: JSON.stringify({
                    first_number: 1,
                    second_number: 2,
                    sum: 3,
                }),
                type: 'text',
            }],
        });

        await client.close();
    });

    it('should remove Actor from tools list', async () => {
        const actor = 'apify/python-example';
        const selectedToolName = actorNameToToolName(actor);
        const client = await createMCPStdioClient({
            actors: [actor],
            enableAddingActors: true,
        });

        // Verify actor is in the tools list
        const toolsBefore = await client.listTools();
        const namesBefore = toolsBefore.tools.map((tool) => tool.name);
        expect(namesBefore).toContain(selectedToolName);

        // Remove the actor
        await client.callTool({
            name: HelperTools.REMOVE_ACTOR,
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
