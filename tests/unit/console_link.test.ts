import { describe, expect, it } from 'vitest';

import { CONSOLE_BASE_URL } from '../../src/const.js';
import { buildConsoleActorUrl, isConsoleUiToken, resolveConsoleLinkContext } from '../../src/utils/console_link.js';

describe('isConsoleUiToken', () => {
    it('detects Console UI tokens by prefix', () => {
        expect(isConsoleUiToken('apify_ui_abc123')).toBe(true);
        expect(isConsoleUiToken('apify_api_abc123')).toBe(false);
        expect(isConsoleUiToken('legacy-token-format')).toBe(false);
        expect(isConsoleUiToken(undefined)).toBe(false);
        expect(isConsoleUiToken('')).toBe(false);
    });
});

describe('resolveConsoleLinkContext', () => {
    const personalUser = { userId: 'USER_ID', userPlanTier: 'FREE' as const, isOrganization: false };
    const orgUser = { userId: 'ORG_ID', userPlanTier: 'FREE' as const, isOrganization: true };

    it('returns undefined for API tokens', () => {
        expect(resolveConsoleLinkContext('apify_api_abc', personalUser)).toBeUndefined();
        expect(resolveConsoleLinkContext('apify_api_abc', orgUser)).toBeUndefined();
    });

    it('returns undefined for a missing token', () => {
        expect(resolveConsoleLinkContext(undefined, personalUser)).toBeUndefined();
    });

    it('returns a context without organizationId for a personal UI token', () => {
        expect(resolveConsoleLinkContext('apify_ui_abc', personalUser)).toEqual({
            consoleBaseUrl: CONSOLE_BASE_URL,
            organizationId: undefined,
        });
    });

    it('returns the acting account as organizationId for an org-scoped UI token', () => {
        expect(resolveConsoleLinkContext('apify_ui_abc', orgUser)).toEqual({
            consoleBaseUrl: CONSOLE_BASE_URL,
            organizationId: 'ORG_ID',
        });
    });

    it('omits organizationId when the user lookup failed (anonymous fallback)', () => {
        const anonymous = { userId: null, userPlanTier: 'FREE' as const, isOrganization: false };
        expect(resolveConsoleLinkContext('apify_ui_abc', anonymous)).toEqual({
            consoleBaseUrl: CONSOLE_BASE_URL,
            organizationId: undefined,
        });
    });
});

describe('buildConsoleActorUrl', () => {
    it('builds a personal Console Actor URL', () => {
        expect(buildConsoleActorUrl({ consoleBaseUrl: 'https://console.apify.com' }, 'ACTOR_ID')).toBe(
            'https://console.apify.com/actors/ACTOR_ID',
        );
    });

    it('builds an org-prefixed Console Actor URL', () => {
        expect(
            buildConsoleActorUrl({ consoleBaseUrl: 'https://console.apify.com', organizationId: 'ORG_ID' }, 'ACTOR_ID'),
        ).toBe('https://console.apify.com/organization/ORG_ID/actors/ACTOR_ID');
    });

    it('normalizes a trailing slash in the base URL', () => {
        expect(buildConsoleActorUrl({ consoleBaseUrl: 'http://localhost:3000/' }, 'ACTOR_ID')).toBe(
            'http://localhost:3000/actors/ACTOR_ID',
        );
    });
});
