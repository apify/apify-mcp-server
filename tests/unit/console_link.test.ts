import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { STAGING_MCP_HOSTNAME } from '../../src/const.js';
import {
    buildConsoleActorUrl,
    buildConsoleDatasetUrl,
    buildConsoleKeyValueStoreUrl,
    buildConsoleRunUrl,
    getConsoleLinkContext,
} from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { mockUserInfo } from './helpers/tool_context.js';

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

describe('getConsoleLinkContext', () => {
    const client = {} as ApifyClient;

    beforeEach(() => {
        vi.mocked(getUserInfoCached).mockReset();
    });

    it('returns undefined for API tokens without a users/me lookup', async () => {
        expect(await getConsoleLinkContext('apify_api_abc', client)).toBeUndefined();
        expect(await getConsoleLinkContext('legacy-token-format', client)).toBeUndefined();
        expect(getUserInfoCached).not.toHaveBeenCalled();
    });

    it('returns undefined for a missing or empty token', async () => {
        expect(await getConsoleLinkContext(undefined, client)).toBeUndefined();
        expect(await getConsoleLinkContext('', client)).toBeUndefined();
        expect(getUserInfoCached).not.toHaveBeenCalled();
    });

    it('returns a context without organizationId for a personal UI token', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        expect(await getConsoleLinkContext('apify_ui_abc', client)).toEqual({ organizationId: undefined });
    });

    it('returns the acting account as organizationId for an org-scoped UI token', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: 'ORG_ID', isOrganization: true }));

        expect(await getConsoleLinkContext('apify_ui_abc', client)).toEqual({ organizationId: 'ORG_ID' });
    });

    it('omits organizationId when the user lookup failed (anonymous fallback)', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));

        expect(await getConsoleLinkContext('apify_ui_abc', client)).toEqual({ organizationId: undefined });
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

    it('returns undefined without a context (non-Console session)', () => {
        expect(buildConsoleActorUrl(undefined, 'ACTOR_ID')).toBeUndefined();
        expect(buildConsoleRunUrl(undefined, 'RUN_ID')).toBeUndefined();
        expect(buildConsoleDatasetUrl(undefined, 'DATASET_ID')).toBeUndefined();
        expect(buildConsoleKeyValueStoreUrl(undefined, 'STORE_ID')).toBeUndefined();
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
