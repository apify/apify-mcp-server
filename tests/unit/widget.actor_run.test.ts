import { describe, expect, it } from 'vitest';

import { extractActorRunErrorMessage } from '../../src/web/src/utils/actor-run.js';

describe('extractActorRunErrorMessage', () => {
    it('strips trailing JSON blob and model instructions from error text', () => {
        const message = extractActorRunErrorMessage({
            isError: true,
            content: [
                {
                    type: 'text',
                    text: [
                        'Failed to call Actor \'apify/rag-web-browser\': Actor not found {"statusCode":404}.',
                        'Please verify the Actor name, input parameters, and ensure the Actor exists.',
                        'You can search for available Actors using the tool: store-search.',
                    ].join('\n'),
                },
            ],
        });

        expect(message).toBe("Failed to call Actor 'apify/rag-web-browser': Actor not found");
    });

    it('returns cleaned first line for single-line errors with JSON blob', () => {
        const message = extractActorRunErrorMessage({
            isError: true,
            content: [
                { type: 'text', text: 'SFAIL Actor not found or definition is not available {"statusCode":404}' },
            ],
        });

        expect(message).toBe('SFAIL Actor not found or definition is not available');
    });

    it('returns null for non-error tool results', () => {
        const message = extractActorRunErrorMessage({
            isError: false,
            content: [
                { type: 'text', text: 'Started Actor "apify/rag-web-browser"' },
            ],
        });

        expect(message).toBeNull();
    });

    it('returns a fallback message when the error response has no text content', () => {
        const message = extractActorRunErrorMessage({
            isError: true,
            content: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
        });

        expect(message).toBe('Actor run failed before it could start.');
    });

    it('returns plain error text when there is no JSON blob to strip', () => {
        const message = extractActorRunErrorMessage({
            isError: true,
            content: [
                { type: 'text', text: 'Failed to call Actor: connection timeout' },
            ],
        });

        expect(message).toBe('Failed to call Actor: connection timeout');
    });
});
