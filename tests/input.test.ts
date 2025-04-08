import { describe, it, expect } from 'vitest';

import { processInput } from '../src/input.js';
import type { Input } from '../src/types.js';

describe('processInput', () => {
    it('should handle string actors input and convert to array', async () => {
        const input: Partial<Input> = {
            actors: 'actor1, actor2,actor3',
        };
        const processed = await processInput(input);
        expect(processed.actors).toEqual(['actor1', 'actor2', 'actor3']);
    });

    it('should keep array actors input unchanged', async () => {
        const input: Partial<Input> = {
            actors: ['actor1', 'actor2', 'actor3'],
        };
        const processed = await processInput(input);
        expect(processed.actors).toEqual(['actor1', 'actor2', 'actor3']);
    });

    it('should handle enableActorAutoLoading to set enableAddingActors', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            enableActorAutoLoading: true,
        };
        const processed = await processInput(input);
        expect(processed.enableAddingActors).toBe(true);
    });

    it('should not override existing enableAddingActors with enableActorAutoLoading', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            enableActorAutoLoading: true,
            enableAddingActors: false,
        };
        const processed = await processInput(input);
        expect(processed.enableAddingActors).toBe(false);
    });

    it('should default enableAddingActors to false when not provided', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
        };
        const processed = await processInput(input);
        expect(processed.enableAddingActors).toBe(false);
    });
});
