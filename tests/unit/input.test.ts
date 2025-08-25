import { describe, expect, it } from 'vitest';

import { processInput } from '../../src/input.js';
import type { Input } from '../../src/types.js';

describe('processInput', () => {
    it('should handle string actors input and convert to tools selectors', async () => {
        const input: Partial<Input> = {
            actors: 'actor1, actor2,actor3',
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['actor1', 'actor2', 'actor3']);
        expect(processed.actors).toBeUndefined();
    });

    it('should move array actors input into tools', async () => {
        const input: Partial<Input> = {
            actors: ['actor1', 'actor2', 'actor3'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['actor1', 'actor2', 'actor3']);
        expect(processed.actors).toBeUndefined();
    });

    it('should handle enableActorAutoLoading to set enableAddingActors', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            enableActorAutoLoading: true,
        };
        const processed = processInput(input);
        expect(processed.enableAddingActors).toBe(true);
    });

    it('should not override existing enableAddingActors with enableActorAutoLoading', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            enableActorAutoLoading: true,
            enableAddingActors: false,
        };
        const processed = processInput(input);
        expect(processed.enableAddingActors).toBe(false);
    });

    it('should default enableAddingActors to false when not provided', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
        };
        const processed = processInput(input);
        expect(processed.enableAddingActors).toBe(false);
    });

    it('should keep tools as array of valid featureTools keys', async () => {
        const input: Partial<Input> = {
            tools: ['docs', 'runs'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs', 'runs']);
    });

    it('should handle empty tools array', async () => {
        const input: Partial<Input> = {
            tools: [],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual([]);
    });

    it('should handle missing tools field (undefined) by moving actors into tools', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['actor1']);
        expect(processed.actors).toBeUndefined();
    });

    it('should include all keys, even invalid ones', async () => {
        const input: Partial<Input> = {
            tools: ['docs', 'invalidKey', 'storage'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs', 'invalidKey', 'storage']);
    });

    it('should merge actors into tools for backward compatibility', async () => {
        const input: Partial<Input> = {
            actors: ['apify/website-content-crawler', 'apify/instagram-scraper'],
            tools: ['docs'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual([
            'docs',
            'apify/website-content-crawler',
            'apify/instagram-scraper',
        ]);
    });

    it('should merge actors into tools when tools is a string', async () => {
        const input: Partial<Input> = {
            actors: ['apify/instagram-scraper'],
            tools: 'runs',
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual([
            'runs',
            'apify/instagram-scraper',
        ]);
    });

    it('should not modify tools if actors is empty array', async () => {
        const input: Partial<Input> = {
            actors: [],
            tools: ['docs'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs']);
    });
});
