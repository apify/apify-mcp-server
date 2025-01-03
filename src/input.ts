import { defaults } from './const.js';
import type { Input } from './types.js';

export async function processInput(originalInput: Partial<Input>) {
    const input = { ...defaults, ...originalInput } as Input;

    if (!input.actorNames || input.actorNames.length === 0) {
        throw new Error('The `actorNames` parameter must be a non-empty array.');
    }
    return { input };
}
