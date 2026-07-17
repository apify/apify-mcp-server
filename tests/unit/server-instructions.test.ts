import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { SERVER_MODE } from '../../src/types.js';
import { getServerInstructions } from '../../src/utils/server-instructions/index.js';

describe('getServerInstructions()', () => {
    it('mentions report-problem with a gentle, non-mandatory nudge when feedback is available', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, true);
        expect(instructions).toContain(HELPER_TOOLS.PROBLEM_REPORT);
        expect(instructions).toContain('you can report it');
        // No hard directive — the directory review rejects MUST-style solicitation.
        expect(instructions).not.toContain('MUST');
        expect(instructions).not.toContain('Reporting problems and feedback');
    });

    it('omits report-problem by default', () => {
        expect(getServerInstructions()).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});
