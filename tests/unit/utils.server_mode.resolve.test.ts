import { describe, expect, it } from 'vitest';

import { SERVER_MODE_AUTO_DETECTION_ENABLED } from '../../src/const.js';
import { SERVER_MODE } from '../../src/types.js';
import { resolveServerMode } from '../../src/utils/server_mode.js';

describe('resolveServerMode', () => {
    it('returns concrete option as-is (capabilities ignored)', () => {
        expect(resolveServerMode(SERVER_MODE.APPS, false)).toBe(SERVER_MODE.APPS);
        expect(resolveServerMode(SERVER_MODE.APPS, true)).toBe(SERVER_MODE.APPS);
        expect(resolveServerMode(SERVER_MODE.DEFAULT, false)).toBe(SERVER_MODE.DEFAULT);
        expect(resolveServerMode(SERVER_MODE.DEFAULT, true)).toBe(SERVER_MODE.DEFAULT);
    });

    it('resolves auto to default when client does not support UI', () => {
        expect(resolveServerMode('auto', false)).toBe(SERVER_MODE.DEFAULT);
    });

    it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'with auto-detection enabled, resolves auto to apps when client supports UI',
        () => {
            expect(resolveServerMode('auto', true)).toBe(SERVER_MODE.APPS);
        },
    );

    it.runIf(!SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'with auto-detection disabled, resolves auto to default regardless of client UI support',
        () => {
            expect(resolveServerMode('auto', true)).toBe(SERVER_MODE.DEFAULT);
        },
    );
});
