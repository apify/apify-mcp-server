import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { ServerMode } from '../../src/types.js';
import { getServerInstructions } from '../../src/utils/server-instructions/index.js';

describe('getServerInstructions()', () => {
    it('advertises share-feedback when feedback is available', () => {
        const instructions = getServerInstructions(ServerMode.DEFAULT, true);
        expect(instructions).toContain(HelperTools.FEEDBACK_SHARE);
        expect(instructions).toContain('Reporting problems and feedback');
    });

    it('omits share-feedback when feedback is unavailable', () => {
        const instructions = getServerInstructions(ServerMode.DEFAULT, false);
        expect(instructions).not.toContain(HelperTools.FEEDBACK_SHARE);
    });

    it('omits share-feedback by default', () => {
        expect(getServerInstructions()).not.toContain(HelperTools.FEEDBACK_SHARE);
    });
});
