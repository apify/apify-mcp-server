import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import { InvalidParamsError } from '../../src/mcp/errors.js';
import { createPromptService } from '../../src/prompts/prompt_service.js';
import type { PromptBase } from '../../src/types.js';

/** AJV stub: a validate function whose verdict and `errors` are fixed for the test. */
function stubAjvValidate(valid: boolean): ValidateFunction {
    return Object.assign(() => valid, { errors: valid ? null : [{ message: 'bad' }] }) as unknown as ValidateFunction;
}

/** A fabricated prompt — the live `prompts` array is empty, so tests supply their own. */
function buildPrompt(overrides: Partial<PromptBase> = {}): PromptBase {
    return {
        name: 'greet',
        description: 'Greets a person',
        ajvValidate: stubAjvValidate(true),
        render: (args: Record<string, string>) => `Hello ${args.who ?? 'world'}`,
        ...overrides,
    } as PromptBase;
}

describe('createPromptService()', () => {
    describe('listPrompts()', () => {
        it('returns the prompts array wrapped in { prompts }', () => {
            const prompts = [buildPrompt()];
            const service = createPromptService(prompts);

            expect(service.listPrompts()).toEqual({ prompts });
        });
    });

    describe('getPrompt()', () => {
        it('renders a known prompt into the user-message shape', () => {
            const service = createPromptService([buildPrompt()]);

            const result = service.getPrompt('greet', { who: 'Ada' });

            expect(result).toEqual({
                description: 'Greets a person',
                messages: [{ role: 'user', content: { type: 'text', text: 'Hello Ada' } }],
            });
        });

        it('throws InvalidParamsError for an unknown prompt name', () => {
            const service = createPromptService([buildPrompt()]);

            expect(() => service.getPrompt('missing')).toThrow(InvalidParamsError);
            expect(() => service.getPrompt('missing')).toThrow('Prompt missing not found. Available prompts: greet');
        });

        it('throws InvalidParamsError when arguments fail AJV validation', () => {
            const service = createPromptService([buildPrompt({ ajvValidate: stubAjvValidate(false) })]);

            expect(() => service.getPrompt('greet', { who: 'Ada' })).toThrow(InvalidParamsError);
            expect(() => service.getPrompt('greet', { who: 'Ada' })).toThrow('Invalid arguments for prompt greet');
        });
    });
});
