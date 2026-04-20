import { describe, expect, it } from 'vitest';

import { parseServerMode, ServerMode } from '../../src/types.js';

describe('parseServerMode', () => {
    it.each([
        ['true', ServerMode.APPS],
        [ServerMode.APPS, ServerMode.APPS],
        ['openai', ServerMode.APPS],
    ])('maps %s → apps', (input, expected) => {
        expect(parseServerMode(input)).toBe(expected);
    });

    it.each([
        ['false', ServerMode.DEFAULT],
        [ServerMode.DEFAULT, ServerMode.DEFAULT],
    ])('maps %s → default', (input, expected) => {
        expect(parseServerMode(input)).toBe(expected);
    });

    it.each([null, undefined, ''])('returns undefined for %s', (input) => {
        expect(parseServerMode(input)).toBeUndefined();
    });

    it('returns undefined for unrecognized values', () => {
        expect(parseServerMode('bogus')).toBeUndefined();
    });
});
