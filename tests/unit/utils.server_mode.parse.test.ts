import { describe, expect, it } from 'vitest';

import { SERVER_MODE } from '../../src/types.js';
import { parseServerMode } from '../../src/utils/server_mode.js';

describe('parseServerMode', () => {
    it.each([
        ['true', SERVER_MODE.APPS],
        ['on', SERVER_MODE.APPS],
        [SERVER_MODE.APPS, SERVER_MODE.APPS],
        ['openai', SERVER_MODE.APPS],
    ])('maps %s → apps', (input, expected) => {
        expect(parseServerMode(input)).toBe(expected);
    });

    it.each([
        ['false', SERVER_MODE.DEFAULT],
        ['off', SERVER_MODE.DEFAULT],
        [SERVER_MODE.DEFAULT, SERVER_MODE.DEFAULT],
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
