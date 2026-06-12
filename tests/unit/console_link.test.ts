import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { STAGING_MCP_HOSTNAME } from '../../src/const.js';
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
        expect(resolveConsoleLinkContext('apify_ui_abc', personalUser)).toEqual({ organizationId: undefined });
    });

    it('returns the acting account as organizationId for an org-scoped UI token', () => {
        expect(resolveConsoleLinkContext('apify_ui_abc', orgUser)).toEqual({ organizationId: 'ORG_ID' });
    });

    it('omits organizationId when the user lookup failed (anonymous fallback)', () => {
        const anonymous = { userId: null, userPlanTier: 'FREE' as const, isOrganization: false };
        expect(resolveConsoleLinkContext('apify_ui_abc', anonymous)).toEqual({ organizationId: undefined });
    });
});

describe('buildConsole*Url (production host)', () => {
    it('builds personal Actor/run/dataset/key-value-store URLs', () => {
        expect(buildConsoleActorUrl({}, 'ACTOR_ID')).toBe('https://console.apify.com/actors/ACTOR_ID');
        expect(buildConsoleRunUrl({}, 'RUN_ID')).toBe('https://console.apify.com/actors/runs/RUN_ID');
        expect(buildConsoleDatasetUrl({}, 'DATASET_ID')).toBe('https://console.apify.com/storage/datasets/DATASET_ID');
        expect(buildConsoleKeyValueStoreUrl({}, 'STORE_ID')).toBe(
            'https://console.apify.com/storage/key-value-stores/STORE_ID',
        );
    });

    it('prefixes org-scoped URLs with /organization/<orgId>', () => {
        const org = { organizationId: 'ORG_ID' };
        expect(buildConsoleActorUrl(org, 'ACTOR_ID')).toBe(
            'https://console.apify.com/organization/ORG_ID/actors/ACTOR_ID',
        );
        expect(buildConsoleRunUrl(org, 'RUN_ID')).toBe(
            'https://console.apify.com/organization/ORG_ID/actors/runs/RUN_ID',
        );
        expect(buildConsoleDatasetUrl(org, 'DATASET_ID')).toBe(
            'https://console.apify.com/organization/ORG_ID/storage/datasets/DATASET_ID',
        );
        expect(buildConsoleKeyValueStoreUrl(org, 'STORE_ID')).toBe(
            'https://console.apify.com/organization/ORG_ID/storage/key-value-stores/STORE_ID',
        );
    });
});

describe('buildConsole*Url (staging host)', () => {
    const original = process.env.HOSTNAME;
    beforeEach(() => {
        process.env.HOSTNAME = STAGING_MCP_HOSTNAME;
    });
    afterEach(() => {
        if (original === undefined) delete process.env.HOSTNAME;
        else process.env.HOSTNAME = original;
    });

    it('uses the staging Console origin when running on the staging MCP host', () => {
        expect(buildConsoleRunUrl({}, 'RUN_ID')).toBe(
            'https://console-securitybyobscurity.apify.com/actors/runs/RUN_ID',
        );
        expect(buildConsoleDatasetUrl({ organizationId: 'ORG_ID' }, 'DATASET_ID')).toBe(
            'https://console-securitybyobscurity.apify.com/organization/ORG_ID/storage/datasets/DATASET_ID',
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

        expect(await getConsoleLinkContext('apify_ui_abc', client)).toEqual({ organizationId: 'ORG_ID' });
    });
});
