import { describe, expect, it } from 'vitest';

import { CONSOLE_BASE_URL } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import {
    buildConsoleActorUrl,
    CONSOLE_CHAT_CLIENT_NAME,
    isConsoleChatClient,
    resolveConsoleLinkContext,
} from '../../src/utils/console_link.js';

function stubServer(clientName?: string): ActorsMcpServer {
    return {
        options: {
            initializeRequestData: clientName
                ? { params: { clientInfo: { name: clientName, version: '0.0.1' } } }
                : undefined,
        },
    } as ActorsMcpServer;
}

describe('isConsoleChatClient', () => {
    it('detects the Apify Console AI chat by MCP client name', () => {
        expect(isConsoleChatClient(stubServer(CONSOLE_CHAT_CLIENT_NAME))).toBe(true);
        expect(isConsoleChatClient(stubServer('claude-ai'))).toBe(false);
        expect(isConsoleChatClient(stubServer())).toBe(false);
    });
});

describe('resolveConsoleLinkContext', () => {
    const personalUser = { userId: 'USER_ID', userPlanTier: 'FREE' as const, isOrganization: false };
    const orgUser = { userId: 'ORG_ID', userPlanTier: 'FREE' as const, isOrganization: true };

    it('returns undefined for non-Console-chat clients', () => {
        expect(resolveConsoleLinkContext(stubServer('claude-ai'), personalUser)).toBeUndefined();
        expect(resolveConsoleLinkContext(stubServer('claude-ai'), orgUser)).toBeUndefined();
    });

    it('returns undefined when no client info is available', () => {
        expect(resolveConsoleLinkContext(stubServer(), personalUser)).toBeUndefined();
    });

    it('returns a context without organizationId for a personal-account chat session', () => {
        expect(resolveConsoleLinkContext(stubServer(CONSOLE_CHAT_CLIENT_NAME), personalUser)).toEqual({
            consoleBaseUrl: CONSOLE_BASE_URL,
            organizationId: undefined,
        });
    });

    it('returns the acting account as organizationId for an org-scoped chat session', () => {
        expect(resolveConsoleLinkContext(stubServer(CONSOLE_CHAT_CLIENT_NAME), orgUser)).toEqual({
            consoleBaseUrl: CONSOLE_BASE_URL,
            organizationId: 'ORG_ID',
        });
    });

    it('omits organizationId when the user lookup failed (anonymous fallback)', () => {
        const anonymous = { userId: null, userPlanTier: 'FREE' as const, isOrganization: false };
        expect(resolveConsoleLinkContext(stubServer(CONSOLE_CHAT_CLIENT_NAME), anonymous)).toEqual({
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
