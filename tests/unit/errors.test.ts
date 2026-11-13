import { describe, expect, it } from 'vitest';

import { ActorLoadError } from '../../src/errors.js';

describe('the message for a tool left out because of its input schema', () => {
    const messageFor = (toolName: string) =>
        ActorLoadError.inputSchemaNotLoaded('apify/example-mcp-server', new Error('invalid'), toolName).message;

    it('names the tool and the Actor', () => {
        expect(messageFor('search-by-country')).toBe(
            'Tool "search-by-country" of Actor "apify/example-mcp-server" was not loaded because its input schema is not valid.',
        );
    });

    it('shows a tool name on one line, without control and formatting characters', () => {
        const toolName = 'search\r\n\u2028by\u0000\u001b[31m-\u202ecountry\u200b\ud83d';

        expect(messageFor(toolName)).toBe(
            'Tool "searchby[31m-country" of Actor "apify/example-mcp-server" was not loaded because its input schema is not valid.',
        );
    });

    it('cuts a long tool name, keeping whole characters', () => {
        const message = messageFor(`${'search-'.repeat(9)}🔎${'-by-country'.repeat(100_000)}`);

        expect(message).toBe(
            `Tool "${'search-'.repeat(9)}🔎…" of Actor "apify/example-mcp-server" was not loaded because its input schema is not valid.`,
        );
    });

    it('cuts a long Actor name the same way', () => {
        const { message } = ActorLoadError.inputSchemaNotLoaded(
            `apify/${'web-scraper-'.repeat(50)}`,
            new Error('invalid'),
        );

        expect(message).toHaveLength('Actor "…" was not loaded because its input schema is not valid.'.length + 64);
    });
});
