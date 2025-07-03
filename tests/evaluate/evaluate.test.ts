import { describe, expect, it } from 'vitest';

import { makeMCPRequest } from './setup.js';

describe.concurrent.for([
    'openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-0',
])('Evaluation Tests (model %s)', (model) => {
    it('Check read not existing dataset', async () => {
        const { mcpCalls, usage } = await makeMCPRequest('Read dataset with id "dataset-id"', model);

        expect(mcpCalls).toEqual([
            {
                tool: 'get-dataset',
                args: {
                    datasetId: 'dataset-id',
                },
            },
        ]);

        console.log('Tokens used:', usage);
    });

    it('Install instagram tool', async () => {
        const { mcpCalls, usage } = await makeMCPRequest('Use instagram scraper and load latest posts with #AI', model);

        expect(mcpCalls).toEqual([
            {
                tool: 'search-actors',
                args: {
                    search: 'instagram scraper',
                    limit: 5,
                },
            },
            {
                tool: 'add-actor',
                args: {
                    actorName: 'apify/instagram-hashtag-scraper',
                },
            },
            {
                tool: 'apify-slash-instragram-hashtag-scraper',
                args: {

                },
            },
        ]);

        console.log('Tokens used:', usage);
    });
});
