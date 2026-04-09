import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInfo = vi.fn();

vi.mock('@apify/log', () => ({
    default: {
        info: (...args: unknown[]) => mockInfo(...args),
    },
}));

// eslint-disable-next-line import/first -- mock must load before module under test
import { fixActorNameInputAndLog } from '../../src/tools/core/actor_tools_factory.js';

describe('fixActorNameInputAndLog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns normalized id and does not log when input is already clean', () => {
        expect(fixActorNameInputAndLog('apify/hello-world', { mcpSessionId: 'sess-1', route: 'fetch-actor-details' })).toBe('apify/hello-world');
        expect(mockInfo).not.toHaveBeenCalled();
    });

    it('logs once when wrappers require normalization', () => {
        const out = fixActorNameInputAndLog('`apify/hello-world`', { mcpSessionId: 'sess-2', route: 'fetch-actor-details' });
        expect(out).toBe('apify/hello-world');
        expect(mockInfo).toHaveBeenCalledTimes(1);
        expect(mockInfo.mock.calls[0][0]).toContain('normalization');
        expect(mockInfo.mock.calls[0][1]).toMatchObject({
            actorNameInput: '`apify/hello-world`',
            actorNameFixed: 'apify/hello-world',
            mcpSessionId: 'sess-2',
            route: 'fetch-actor-details',
        });
    });
});
