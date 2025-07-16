import { describe, expect, it } from 'vitest';

import { processInput } from '../../src/input.js';
import type { Input } from '../../src/types.js';

describe('processInput', () => {
    it('should handle string actors input and convert to array', async () => {
        const input: Partial<Input> = {
            actors: 'actor1, actor2,actor3',
        };
        const processed = processInput(input);
        expect(processed.actors).toEqual(['actor1', 'actor2', 'actor3']);
    });

    it('should keep array actors input unchanged', async () => {
        const input: Partial<Input> = {
            actors: ['actor1', 'actor2', 'actor3'],
        };
        const processed = processInput(input);
        expect(processed.actors).toEqual(['actor1', 'actor2', 'actor3']);
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

    it('should default enableAddingActors to true when not provided', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
        };
        const processed = processInput(input);
        expect(processed.enableAddingActors).toBe(true);
    });

    it('should disable beta features by default', async () => {
        const input: Partial<Input> = {
            beta: undefined,
        };
        const processed = processInput(input);
        expect(processed.beta).toBe(false);
    });

    it('should disable beta features when beta is false', async () => {
        const input: Partial<Input> = {
            beta: false,
        };
        const processed = processInput(input);
        expect(processed.beta).toBe(false);
    });

    it('should disable beta when beta is "false"', async () => {
        const input: Partial<Input> = {
            beta: 'false',
        };
        const processed = processInput(input);
        expect(processed.beta).toBe(false);
    });

    it('should enable beta features when beta non empty string', async () => {
        const input: Partial<Input> = {
            beta: '1',
        };
        const processed = processInput(input);
        expect(processed.beta).toBe(true);
    });

    it('should enable beta features when beta is true', async () => {
        const input: Partial<Input> = {
            beta: true,
        };
        const processed = processInput(input);
        expect(processed.beta).toBe(true);
    });

    it('should keep tools as array of valid featureTools keys', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            tools: ['docs', 'runs'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs', 'runs']);
    });

    it('should handle empty tools array', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            tools: [],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual([]);
    });

    it('should handle missing tools field (undefined)', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
        };
        const processed = processInput(input);
        expect(processed.tools).toBeUndefined();
    });

    it('should include all keys, even invalid ones', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            // @ts-expect-error: purposely invalid key for test
            tools: ['docs', 'invalidKey', 'storage'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs', 'invalidKey', 'storage']);
    });
});
