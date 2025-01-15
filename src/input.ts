import { defaults } from './const.js';
import type { Input } from './types.js';

/**
 * Process input parameters, split actors string into an array
 * @param originalInput
 * @returns input
 */
export async function processInput(originalInput: Partial<Input>): Promise<Input> {
    const input = { ...defaults, ...originalInput } as Input;

    // actors can be a string or an array of strings
    if (input.actors && typeof input.actors === 'string') {
        input.actors = input.actors.split(',').map((format: string) => format.trim()) as string[];
    }
    if (!input.actors || input.actors.length === 0) {
        throw new Error('The `actors` parameter must be a non-empty array.');
    }
    return input;
}
