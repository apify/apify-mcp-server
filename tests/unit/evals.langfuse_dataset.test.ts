import type { LangfuseClient } from '@langfuse/client';
import { describe, expect, it } from 'vitest';

import { fetchMcpAgentCases, parseMcpAgentItem, toMcpAgentTestCase } from '../../evals/mcp_agent/langfuse_dataset.js';

const item = { id: 'a', input: { query: 'q' }, expectedOutput: 'r', metadata: { category: 'search' } };

/** Langfuse client whose dataset holds the given items, like the real API returns them. */
function makeLangfuseClient(items: unknown[]) {
    const requested: unknown[] = [];
    const client = {
        dataset: {
            get: async (name: string, options?: unknown) => {
                requested.push({ name, options });
                return { items: items.map((entry) => ({ status: 'ACTIVE', ...(entry as object) })) };
            },
        },
    } as unknown as LangfuseClient;
    return { client, requested };
}

describe('parseMcpAgentItem()', () => {
    it('returns the fields a run reads', () => {
        expect(parseMcpAgentItem(item)).toEqual(item);
    });

    it('keeps the optional harness knobs from metadata', () => {
        const withKnobs = { ...item, metadata: { category: 'search', maxTurns: 5, failTools: ['call-actor'] } };
        expect(parseMcpAgentItem(withKnobs).metadata).toEqual(withKnobs.metadata);
    });

    it('rejects a misspelled knob instead of silently stripping it', () => {
        const typo = { ...item, metadata: { category: 'search', failTool: ['call-actor'] } };
        expect(() => parseMcpAgentItem(typo)).toThrow(/failTool/);
    });

    it('throws naming the item when metadata was cleared', () => {
        expect(() => parseMcpAgentItem({ ...item, metadata: undefined })).toThrow(/Dataset item "a"/);
    });

    it('throws when the query or the reference is empty', () => {
        expect(() => parseMcpAgentItem({ ...item, input: { query: '' } })).toThrow(/not a usable MCP agent test case/);
        expect(() => parseMcpAgentItem({ ...item, expectedOutput: '' })).toThrow(/not a usable MCP agent test case/);
    });

    it('reports an unknown id when the item is not an object', () => {
        expect(() => parseMcpAgentItem(null)).toThrow(/Dataset item "\(unknown\)"/);
    });
});

describe('toMcpAgentTestCase()', () => {
    it('flattens an item into a test case', () => {
        expect(toMcpAgentTestCase(item)).toEqual({ id: 'a', category: 'search', query: 'q', reference: 'r' });
    });

    it('leaves out knobs the item does not set, so the snapshot stays minimal', () => {
        expect(Object.keys(toMcpAgentTestCase(item))).toEqual(['id', 'category', 'query', 'reference']);
    });

    it('writes the keys in a fixed order whatever order metadata arrives in', () => {
        const knobs = { failTools: ['call-actor'], tools: ['actors'], category: 'search', maxTurns: 5 };
        expect(Object.keys(toMcpAgentTestCase({ ...item, metadata: knobs }))).toEqual([
            'id',
            'category',
            'query',
            'reference',
            'maxTurns',
            'tools',
            'failTools',
        ]);
    });
});

describe('fetchMcpAgentCases()', () => {
    it('returns each active case with the item the experiment runs on', async () => {
        const { client, requested } = makeLangfuseClient([item]);
        const cases = await fetchMcpAgentCases(client, 'mcp-agent-evals');

        expect(requested).toEqual([{ name: 'mcp-agent-evals', options: { fetchItemsPageSize: 100 } }]);
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ id: 'a', category: 'search', query: 'q', reference: 'r' });
        expect(cases[0].item).toMatchObject({ id: 'a', status: 'ACTIVE' });
    });

    it('drops archived items, which dataset.get returns regardless of status', async () => {
        const { client } = makeLangfuseClient([item, { ...item, id: 'b', status: 'ARCHIVED' }]);
        expect((await fetchMcpAgentCases(client, 'mcp-agent-evals')).map((entry) => entry.id)).toEqual(['a']);
    });

    it('sorts by id, so run order and the snapshot do not depend on the API', async () => {
        const { client } = makeLangfuseClient([{ ...item, id: 'c' }, item, { ...item, id: 'b' }]);
        expect((await fetchMcpAgentCases(client, 'mcp-agent-evals')).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    });

    it('throws on a malformed item, before the run spends anything on LLM calls', async () => {
        const { client } = makeLangfuseClient([item, { ...item, id: 'b', metadata: {} }]);
        await expect(fetchMcpAgentCases(client, 'mcp-agent-evals')).rejects.toThrow(/Dataset item "b"/);
    });
});
