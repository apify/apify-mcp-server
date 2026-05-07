import { describe, expect, it } from 'vitest';

import { ServerMode } from '../../src/types.js';
import { parseServerMode } from '../../src/utils/server_mode.js';

describe('parseServerMode', () => {
    it.each([
        ['true', ServerMode.APPS],
        ['on', ServerMode.APPS],
        [ServerMode.APPS, ServerMode.APPS],
        ['openai', ServerMode.APPS],
    ])('maps %s → apps', (input, expected) => {
        expect(parseServerMode(input)).toBe(expected);
    });

    it.each([
        ['false', ServerMode.DEFAULT],
        ['off', ServerMode.DEFAULT],
        [ServerMode.DEFAULT, ServerMode.DEFAULT],
    ])('maps %s → default', (input, expected) => {
        expect(parseServerMode(input)).toBe(expected);
    });

    it('maps auto → auto', () => {
        expect(parseServerMode('auto')).toBe('auto');
    });

    it.each([null, undefined, ''])('returns auto for %s', (input) => {
        expect(parseServerMode(input)).toBe('auto');
    });

    it('returns auto for unrecognized values', () => {
        expect(parseServerMode('bogus')).toBe('auto');
    });
});
