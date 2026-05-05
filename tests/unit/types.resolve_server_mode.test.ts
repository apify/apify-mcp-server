import { describe, expect, it } from 'vitest';

import { IS_SERVER_MODE_AUTO_DETECTION_ENABLED, resolveServerMode, ServerMode } from '../../src/types.js';

describe('resolveServerMode', () => {
    it('returns concrete option as-is (capabilities ignored)', () => {
        expect(resolveServerMode(ServerMode.APPS, false)).toBe(ServerMode.APPS);
        expect(resolveServerMode(ServerMode.APPS, true)).toBe(ServerMode.APPS);
        expect(resolveServerMode(ServerMode.DEFAULT, false)).toBe(ServerMode.DEFAULT);
        expect(resolveServerMode(ServerMode.DEFAULT, true)).toBe(ServerMode.DEFAULT);
    });

    it('resolves auto to default when client does not support UI', () => {
        expect(resolveServerMode('auto', false)).toBe(ServerMode.DEFAULT);
    });

    it.runIf(IS_SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'with kill switch on, resolves auto to apps when client supports UI',
        () => {
            expect(resolveServerMode('auto', true)).toBe(ServerMode.APPS);
        },
    );

    it.runIf(!IS_SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'with kill switch off, resolves auto to default regardless of client UI support',
        () => {
            expect(resolveServerMode('auto', true)).toBe(ServerMode.DEFAULT);
        },
    );
});
