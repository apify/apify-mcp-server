import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { canRunActor } from '../../src/tools/actors/actor_run_availability.js';

const ACTOR_FULL_NAME = 'apify/web-scraper';
// Longer than MAX_TOOL_NAME_LENGTH, so its dedicated tool is registered truncated + hashed.
const LONG_ACTOR_FULL_NAME = `apify/${'a'.repeat(80)}`;

describe('canRunActor()', () => {
    it('returns true when call-actor is loaded', () => {
        expect(canRunActor(ACTOR_FULL_NAME, [HELPER_TOOLS.ACTOR_CALL])).toBe(true);
    });

    it('returns true when only call-actor-widget is loaded', () => {
        expect(canRunActor(ACTOR_FULL_NAME, [HELPER_TOOLS.ACTOR_CALL_WIDGET])).toBe(true);
    });

    it('returns true when the Actor has its own dedicated tool', () => {
        expect(canRunActor(ACTOR_FULL_NAME, [actorNameToToolName(ACTOR_FULL_NAME)])).toBe(true);
    });

    it('matches the truncated and hashed tool name of a long Actor name', () => {
        const hashedToolName = actorNameToToolName(LONG_ACTOR_FULL_NAME);

        expect(hashedToolName).not.toBe(LONG_ACTOR_FULL_NAME);
        expect(canRunActor(LONG_ACTOR_FULL_NAME, [hashedToolName])).toBe(true);
        // The unhashed full name is not what the registry holds, so it must not match.
        expect(canRunActor(LONG_ACTOR_FULL_NAME, [LONG_ACTOR_FULL_NAME])).toBe(false);
    });

    it('returns false when none of the three tool names is loaded', () => {
        expect(
            canRunActor(ACTOR_FULL_NAME, [
                HELPER_TOOLS.ACTOR_GET_DETAILS,
                actorNameToToolName('apify/rag-web-browser'),
            ]),
        ).toBe(false);
    });

    it('returns false for an empty tool set', () => {
        expect(canRunActor(ACTOR_FULL_NAME, [])).toBe(false);
    });
});
