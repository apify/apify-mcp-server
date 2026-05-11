import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { describe, expect, it, vi } from 'vitest';

import { isTaskCancelled, parseInputParamsFromUrl } from '../../src/mcp/utils.js';

describe('parseInputParamsFromUrl()', () => {
    it('handles URL without query params', () => {
        const url = 'https://mcp.apify.com';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toBeUndefined();
    });

    it('parses Actors from URL query params as tools', () => {
        const url = 'https://mcp.apify.com?token=123&actors=apify/web-scraper';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/web-scraper']);
        expect(result.actors).toBeUndefined();
    });

    it('parses multiple Actors from URL as tools', () => {
        const url = 'https://mcp.apify.com?actors=apify/instagram-scraper,lukaskrivka/google-maps';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/instagram-scraper', 'lukaskrivka/google-maps']);
        expect(result.actors).toBeUndefined();
    });

    it('handles Actors as string parameter as tools', () => {
        const url = 'https://mcp.apify.com?actors=apify/rag-web-browser';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/rag-web-browser']);
        expect(result.actors).toBeUndefined();
    });

    it('parses the deprecated enableActorAutoLoading flag as enableAddingActors', () => {
        const url = 'https://mcp.apify.com?enableActorAutoLoading=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('parses enableAddingActors=true', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('parses enableAddingActors=false', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=false';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(false);
    });
});

describe('isTaskCancelled()', () => {
    const makeTaskStore = (getTaskReturn: unknown) => ({
        getTask: vi.fn().mockResolvedValue(getTaskReturn),
    } as unknown as TaskStore);

    it('returns true when task status is cancelled', async () => {
        const taskStore = makeTaskStore({ status: 'cancelled' });
        const result = await isTaskCancelled('task-1', 'session-1', taskStore);

        expect(result).toBe(true);
    });

    it('returns false when task status is not cancelled', async () => {
        const taskStore = makeTaskStore({ status: 'working' });
        const result = await isTaskCancelled('task-1', 'session-1', taskStore);

        expect(result).toBe(false);
    });

    it('returns false when task is not found (getTask returns undefined)', async () => {
        const taskStore = makeTaskStore(undefined);
        const result = await isTaskCancelled('task-1', 'session-1', taskStore);

        expect(result).toBe(false);
    });

    it('passes taskId and mcpSessionId through to taskStore.getTask', async () => {
        const taskStore = makeTaskStore({ status: 'working' });
        await isTaskCancelled('task-42', 'session-xyz', taskStore);

        expect(taskStore.getTask).toHaveBeenCalledWith('task-42', 'session-xyz');
    });
});
