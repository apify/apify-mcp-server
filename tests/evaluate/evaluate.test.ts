import { describe, expect, it } from 'vitest';

import { makeMCPRequest } from './setup.js';

describe('Evaluation Tests', () => {
    it('Check read not existing dataset', async () => {
        const result = await makeMCPRequest('Read dataset with id "dataset-id"');

        const mcpCalls = result.steps.flatMap((step) => step.toolCalls).map((call) => ({
            tool: call.toolName,
            args: call.args,
        }));

        expect(mcpCalls).toEqual([
            {
                tool: 'get-dataset',
                args: {
                    datasetId: 'dataset-id',
                },
            },
        ]);

        console.log('Tokens used:', result.steps.reduce((sum, step) => sum + step.usage.totalTokens, 0));
    });

    it.only('Install instagram tool', async () => {
        const result = await makeMCPRequest('Install instagram scraper and load latest data about "apify" on Instagram');

        const mcpCalls = result.steps.flatMap((step) => step.toolCalls).map((call) => ({
            tool: call.toolName,
            args: call.args,
        }));

        expect(mcpCalls).toEqual([
            {
                tool: 'add-actor',
                args: {
                    actorName: 'apify/instagram-scraper',
                },
            },
            {
                tool: 'apify-slash-instragram-scraper',
                args: {

                },
            },
        ]);

        console.log('Tokens used:', result.steps.reduce((sum, step) => sum + step.usage.totalTokens, 0));
    });
});
