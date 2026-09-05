import type { LangfuseClient } from '@langfuse/client';
import { describe, expect, it } from 'vitest';

import {
    fetchMcpAgentCases,
    filterByTier,
    parseMcpAgentItem,
    toMcpAgentTestCase,
} from '../../evals/mcp_agent/langfuse_dataset.js';

const item = {
    id: 'a',
    input: { query: 'q' },
    expectedOutput: 'r',
    metadata: { category: 'search', kind: 'agent', tier: ['full'] },
};

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
        const withKnobs = {
            ...item,
            metadata: { category: 'search', kind: 'agent', tier: ['full'], maxTurns: 5, failTools: ['call-actor'] },
        };
        expect(parseMcpAgentItem(withKnobs).metadata).toEqual(withKnobs.metadata);
    });

    it('rejects a misspelled knob instead of silently stripping it', () => {
        const typo = {
            ...item,
            metadata: { category: 'search', kind: 'agent', tier: ['full'], failTool: ['call-actor'] },
        };
        expect(() => parseMcpAgentItem(typo)).toThrow(/failTool/);
    });

    it('rejects a misspelled expectedErrors key instead of silently stripping it', () => {
        const typo = {
            ...item,
            metadata: { category: 'search', kind: 'agent', tier: ['full'], expectedErorrs: ['get-actor-task'] },
        };
        expect(() => parseMcpAgentItem(typo)).toThrow(/expectedErorrs/);
    });

    it('throws naming the item when metadata was cleared', () => {
        expect(() => parseMcpAgentItem({ ...item, metadata: undefined })).toThrow(/Dataset item "a"/);
    });

    it('throws when the query is empty', () => {
        expect(() => parseMcpAgentItem({ ...item, input: { query: '' } })).toThrow(/not a usable MCP agent test case/);
    });

    it('throws when expectedOutput is an empty string', () => {
        expect(() => parseMcpAgentItem({ ...item, expectedOutput: '' })).toThrow(/not a usable MCP agent test case/);
    });

    it('reports an unknown id when the item is not an object', () => {
        expect(() => parseMcpAgentItem(null)).toThrow(/Dataset item "\(unknown\)"/);
    });

    it('accepts a kind: agent item with a populated expectedErrors array', () => {
        const withErrors = {
            ...item,
            metadata: { category: 'get', kind: 'agent', tier: ['full'], expectedErrors: ['get-actor-task'] },
        };
        expect(parseMcpAgentItem(withErrors).metadata.expectedErrors).toEqual(['get-actor-task']);
    });

    it('accepts a kind: selection item with expectedTools and no expectedOutput', () => {
        const selection = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'selection', tier: ['pr'], expectedTools: ['search-actors'] },
        };
        expect(parseMcpAgentItem(selection).expectedOutput).toBeUndefined();
    });

    it('rejects a kind: selection item with no expectedTools, naming the missing field', () => {
        const selection = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'selection', tier: ['pr'] },
        };
        expect(() => parseMcpAgentItem(selection)).toThrow(
            /metadata\.kind \\"selection\\" requires a non-empty \\"expectedTools\\"/,
        );
    });

    it('rejects a kind: selection item with an empty expectedTools array', () => {
        const selection = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'selection', tier: ['pr'], expectedTools: [] },
        };
        expect(() => parseMcpAgentItem(selection)).toThrow(/expectedTools/);
    });

    it('rejects a kind: agent item with no expectedOutput', () => {
        const noReference = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'agent', tier: ['full'] },
        };
        expect(() => parseMcpAgentItem(noReference)).toThrow(
            /metadata\.kind \\"agent\\" requires a non-empty \\"expectedOutput\\"/,
        );
    });

    it('rejects an empty tier array', () => {
        expect(() => parseMcpAgentItem({ ...item, metadata: { ...item.metadata, tier: [] } })).toThrow(
            /not a usable MCP agent test case/,
        );
    });

    it('rejects an unknown kind value', () => {
        expect(() => parseMcpAgentItem({ ...item, metadata: { ...item.metadata, kind: 'bogus' } })).toThrow(
            /not a usable MCP agent test case/,
        );
    });

    it("treats a null expectedOutput (Langfuse's API shape for an absent field) as absent", () => {
        // The Langfuse dataset-items API returns `expectedOutput: null`, not an absent key,
        // when an item never set it - which every kind: "selection" item does in practice.
        const selection = {
            id: 'b',
            input: { query: 'q' },
            expectedOutput: null,
            metadata: { category: 'search', kind: 'selection', tier: ['pr'], expectedTools: ['search-actors'] },
        };
        expect(parseMcpAgentItem(selection).expectedOutput).toBeUndefined();
    });

    it('accepts a kind: selection item with expectedArgs and mcpToolsOnly', () => {
        const selection = {
            id: 'b',
            input: { query: 'q' },
            metadata: {
                category: 'search',
                kind: 'selection',
                tier: ['pr'],
                expectedTools: ['fetch-actor-details'],
                expectedArgs: { actor: 'apify/rag-web-browser' },
                mcpToolsOnly: true,
            },
        };
        const parsed = parseMcpAgentItem(selection);
        expect(parsed.metadata.expectedArgs).toEqual({ actor: 'apify/rag-web-browser' });
        expect(parsed.metadata.mcpToolsOnly).toBe(true);
    });

    it('accepts a runner-injected iteration on an agent item', () => {
        const withIteration = { ...item, metadata: { ...item.metadata, iteration: 2 } };
        expect(parseMcpAgentItem(withIteration).metadata.iteration).toBe(2);
    });

    it('rejects expectedArgs on a kind: agent item', () => {
        const withArgs = {
            ...item,
            metadata: { ...item.metadata, expectedArgs: { actor: 'apify/rag-web-browser' } },
        };
        expect(() => parseMcpAgentItem(withArgs)).toThrow(/expectedArgs/);
    });

    it('rejects maxTurns on a kind: selection item', () => {
        const selection = {
            id: 'b',
            input: { query: 'q' },
            metadata: {
                category: 'search',
                kind: 'selection',
                tier: ['pr'],
                expectedTools: ['search-actors'],
                maxTurns: 3,
            },
        };
        expect(() => parseMcpAgentItem(selection)).toThrow(/maxTurns/);
    });

    it('rejects a bogus extra metadata key on an otherwise valid item', () => {
        const bogus = { ...item, metadata: { ...item.metadata, bogusKey: true } };
        expect(() => parseMcpAgentItem(bogus)).toThrow(/bogusKey/);
    });
});

describe('toMcpAgentTestCase()', () => {
    it('flattens an item into a test case', () => {
        expect(toMcpAgentTestCase(item)).toEqual({
            id: 'a',
            category: 'search',
            kind: 'agent',
            tier: ['full'],
            query: 'q',
            reference: 'r',
        });
    });

    it('leaves out knobs the item does not set, so the snapshot stays minimal', () => {
        expect(Object.keys(toMcpAgentTestCase(item))).toEqual(['id', 'category', 'kind', 'tier', 'query', 'reference']);
    });

    it('writes the keys in a fixed order whatever order metadata arrives in', () => {
        const knobs = {
            failTools: ['call-actor'],
            tools: ['actors'],
            tier: ['full'],
            maxTurns: 5,
            expectedErrors: ['get-actor-task'],
            category: 'search',
            kind: 'agent',
            mcpToolsOnly: true,
        };
        expect(Object.keys(toMcpAgentTestCase({ ...item, metadata: knobs }))).toEqual([
            'id',
            'category',
            'kind',
            'tier',
            'query',
            'reference',
            'expectedErrors',
            'maxTurns',
            'tools',
            'failTools',
            'mcpToolsOnly',
        ]);
    });

    it('flattens a selection item, dropping the absent reference and adding expectedTools/expectedArgs', () => {
        const selection = {
            id: 'b',
            input: { query: 'q' },
            metadata: {
                category: 'search',
                kind: 'selection',
                tier: ['pr'],
                expectedTools: ['search-actors'],
                expectedArgs: { actor: 'apify/rag-web-browser' },
            },
        };
        expect(toMcpAgentTestCase(selection)).toEqual({
            id: 'b',
            category: 'search',
            kind: 'selection',
            tier: ['pr'],
            query: 'q',
            expectedTools: ['search-actors'],
            expectedArgs: { actor: 'apify/rag-web-browser' },
        });
    });

    it('writes expectedArgs right after expectedTools', () => {
        const selection = {
            id: 'b',
            input: { query: 'q' },
            metadata: {
                category: 'search',
                kind: 'selection',
                tier: ['pr'],
                expectedTools: ['search-actors'],
                expectedArgs: { actor: 'apify/rag-web-browser' },
            },
        };
        expect(Object.keys(toMcpAgentTestCase(selection))).toEqual([
            'id',
            'category',
            'kind',
            'tier',
            'query',
            'expectedTools',
            'expectedArgs',
        ]);
    });

    it('never exports a runner-injected iteration', () => {
        const withIteration = { ...item, metadata: { ...item.metadata, iteration: 3 } };
        expect(Object.keys(toMcpAgentTestCase(withIteration))).not.toContain('iteration');
    });
});

describe('filterByTier()', () => {
    const pr = { id: 'a', category: 'x', query: 'q', tier: ['pr'] };
    const full = { id: 'b', category: 'x', query: 'q', tier: ['full'] };
    const both = { id: 'c', category: 'x', query: 'q', tier: ['pr', 'full'] };
    const cases = [pr, full, both];

    it('keeps items whose tier array contains "pr"', () => {
        expect(filterByTier(cases, 'pr').map((c) => c.id)).toEqual(['a', 'c']);
    });

    it('keeps items whose tier array contains "full"', () => {
        expect(filterByTier(cases, 'full').map((c) => c.id)).toEqual(['b', 'c']);
    });
});

describe('fetchMcpAgentCases()', () => {
    it('returns each active case with the item the experiment runs on', async () => {
        const { client, requested } = makeLangfuseClient([item]);
        const cases = await fetchMcpAgentCases(client, 'mcp-server-evals');

        expect(requested).toEqual([{ name: 'mcp-server-evals', options: { fetchItemsPageSize: 100 } }]);
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ id: 'a', category: 'search', query: 'q', reference: 'r' });
        expect(cases[0].item).toMatchObject({ id: 'a', status: 'ACTIVE' });
    });

    it('drops archived items, which dataset.get returns regardless of status', async () => {
        const { client } = makeLangfuseClient([item, { ...item, id: 'b', status: 'ARCHIVED' }]);
        expect((await fetchMcpAgentCases(client, 'mcp-server-evals')).map((entry) => entry.id)).toEqual(['a']);
    });

    it('sorts by id, so run order and the snapshot do not depend on the API', async () => {
        const { client } = makeLangfuseClient([{ ...item, id: 'c' }, item, { ...item, id: 'b' }]);
        expect((await fetchMcpAgentCases(client, 'mcp-server-evals')).map((entry) => entry.id)).toEqual([
            'a',
            'b',
            'c',
        ]);
    });

    it('throws on a malformed item, before the run spends anything on LLM calls', async () => {
        const { client } = makeLangfuseClient([item, { ...item, id: 'b', metadata: {} }]);
        await expect(fetchMcpAgentCases(client, 'mcp-server-evals')).rejects.toThrow(/Dataset item "b"/);
    });
});
