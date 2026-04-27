import { describe, expect, it } from 'vitest';

import { resolveServerMode, ServerMode } from '../../src/types.js';

describe('resolveServerMode', () => {
    it('returns concrete option as-is (capabilities ignored)', () => {
        expect(resolveServerMode(ServerMode.APPS, false)).toBe(ServerMode.APPS);
        expect(resolveServerMode(ServerMode.APPS, true)).toBe(ServerMode.APPS);
        expect(resolveServerMode(ServerMode.DEFAULT, false)).toBe(ServerMode.DEFAULT);
        expect(resolveServerMode(ServerMode.DEFAULT, true)).toBe(ServerMode.DEFAULT);
    });

    // TODO: re-enable when auto-detect is restored in resolveServerMode (src/types.ts).
    it.skip('resolves auto to apps when client supports UI', () => {
        expect(resolveServerMode('auto', true)).toBe(ServerMode.APPS);
    });

    it('resolves auto to default regardless of client capabilities (auto-detect disabled)', () => {
        expect(resolveServerMode('auto', false)).toBe(ServerMode.DEFAULT);
        expect(resolveServerMode('auto', true)).toBe(ServerMode.DEFAULT);
    });
});
