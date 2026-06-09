import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { CONSOLE_BASE_URL } from '../../src/const.js';
import {
    buildConsoleActorUrl,
    buildConsoleDatasetUrl,
    buildConsoleKeyValueStoreUrl,
    buildConsoleRunUrl,
    getConsoleLinkContext,
    isConsoleUiToken,
    resolveConsoleLinkContext,
} from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

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

describe('buildConsoleRunUrl / buildConsoleDatasetUrl / buildConsoleKeyValueStoreUrl', () => {
    const personal = { consoleBaseUrl: 'https://console.apify.com' };
    const org = { consoleBaseUrl: 'https://console.apify.com', organizationId: 'ORG_ID' };

    it('builds run URLs', () => {
        expect(buildConsoleRunUrl(personal, 'RUN_ID')).toBe('https://console.apify.com/actors/runs/RUN_ID');
        expect(buildConsoleRunUrl(org, 'RUN_ID')).toBe(
            'https://console.apify.com/organization/ORG_ID/actors/runs/RUN_ID',
        );
    });

    it('builds dataset URLs', () => {
        expect(buildConsoleDatasetUrl(personal, 'DATASET_ID')).toBe(
            'https://console.apify.com/storage/datasets/DATASET_ID',
        );
        expect(buildConsoleDatasetUrl(org, 'DATASET_ID')).toBe(
            'https://console.apify.com/organization/ORG_ID/storage/datasets/DATASET_ID',
        );
    });

    it('builds key-value store URLs', () => {
        expect(buildConsoleKeyValueStoreUrl(personal, 'STORE_ID')).toBe(
            'https://console.apify.com/storage/key-value-stores/STORE_ID',
        );
        expect(buildConsoleKeyValueStoreUrl(org, 'STORE_ID')).toBe(
            'https://console.apify.com/organization/ORG_ID/storage/key-value-stores/STORE_ID',
        );
    });
});

describe('getConsoleLinkContext', () => {
    const client = {} as ApifyClient;

    beforeEach(() => {
        vi.mocked(getUserInfoCached).mockReset();
    });

    it('returns undefined for API tokens without a users/me lookup', async () => {
        expect(await getConsoleLinkContext('apify_api_abc', client)).toBeUndefined();
        expect(getUserInfoCached).not.toHaveBeenCalled();
    });

    it('resolves the context for UI tokens via the cached users/me lookup', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue({
            userId: 'ORG_ID',
            userPlanTier: 'FREE',
            isOrganization: true,
        });

        expect(await getConsoleLinkContext('apify_ui_abc', client)).toEqual({
            consoleBaseUrl: CONSOLE_BASE_URL,
            organizationId: 'ORG_ID',
        });
    });
});
