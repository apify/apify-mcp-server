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
    metadata: { category: 'search', kind: 'agent', tier: ['merge'] },
};

const toolCallItem = {
    id: 'b',
    input: { query: 'q' },
    metadata: { category: 'search', kind: 'tool-call', tier: ['pr'], expectedTools: ['search-actors'] },
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
            metadata: { category: 'search', kind: 'agent', tier: ['merge'], maxTurns: 5, failTools: ['call-actor'] },
        };
        expect(parseMcpAgentItem(withKnobs).metadata).toEqual(withKnobs.metadata);
    });

    it('rejects a misspelled knob instead of silently stripping it', () => {
        const typo = {
            ...item,
            metadata: { category: 'search', kind: 'agent', tier: ['merge'], failTool: ['call-actor'] },
        };
        expect(() => parseMcpAgentItem(typo)).toThrow(/failTool/);
    });

    it('rejects a misspelled expectedErrors key instead of silently stripping it', () => {
        const typo = {
            ...item,
            metadata: { category: 'search', kind: 'agent', tier: ['merge'], expectedErorrs: ['get-actor-task'] },
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
            metadata: { category: 'get', kind: 'agent', tier: ['merge'], expectedErrors: ['get-actor-task'] },
        };
        expect(parseMcpAgentItem(withErrors).metadata.expectedErrors).toEqual(['get-actor-task']);
    });

    it('accepts a kind: tool-call item with expectedTools and no expectedOutput', () => {
        const toolCall = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'tool-call', tier: ['pr'], expectedTools: ['search-actors'] },
        };
        expect(parseMcpAgentItem(toolCall).expectedOutput).toBeUndefined();
    });

    it('rejects a kind: tool-call item carrying an expectedOutput, which nothing would judge', () => {
        const toolCall = {
            id: 'b',
            input: { query: 'q' },
            expectedOutput: 'a reference no judge ever reads',
            metadata: { category: 'search', kind: 'tool-call', tier: ['pr'], expectedTools: ['search-actors'] },
        };
        expect(() => parseMcpAgentItem(toolCall)).toThrow(/expectedOutput is not valid on a kind/);
    });

    it('rejects a kind: tool-call item with no expectedTools, naming the missing field', () => {
        const toolCall = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'tool-call', tier: ['pr'] },
        };
        expect(() => parseMcpAgentItem(toolCall)).toThrow(
            /metadata\.kind \\"tool-call\\" requires a non-empty \\"expectedTools\\"/,
        );
    });

    it('rejects a kind: tool-call item with an empty expectedTools array', () => {
        const toolCall = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'tool-call', tier: ['pr'], expectedTools: [] },
        };
        expect(() => parseMcpAgentItem(toolCall)).toThrow(/expectedTools/);
    });

    it('rejects a kind: agent item with no expectedOutput', () => {
        const noReference = {
            id: 'b',
            input: { query: 'q' },
            metadata: { category: 'search', kind: 'agent', tier: ['merge'] },
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
        // when an item never set it - which every kind: "tool-call" item does in practice.
        const toolCall = {
            id: 'b',
            input: { query: 'q' },
            expectedOutput: null,
            metadata: { category: 'search', kind: 'tool-call', tier: ['pr'], expectedTools: ['search-actors'] },
        };
        expect(parseMcpAgentItem(toolCall).expectedOutput).toBeUndefined();
    });

    it('accepts a kind: tool-call item with expectedArgs and mcpToolsOnly', () => {
        const toolCall = {
            id: 'b',
            input: { query: 'q' },
            metadata: {
                category: 'search',
                kind: 'tool-call',
                tier: ['pr'],
                expectedTools: ['fetch-actor-details'],
                expectedArgs: { actor: 'apify/rag-web-browser' },
                mcpToolsOnly: true,
            },
        };
        const parsed = parseMcpAgentItem(toolCall);
        expect(parsed.metadata.expectedArgs).toEqual({ actor: 'apify/rag-web-browser' });
        expect(parsed.metadata.mcpToolsOnly).toBe(true);
    });

    it('accepts a runner-injected iteration on an agent item', () => {
        const withIteration = { ...item, metadata: { ...item.metadata, iteration: 2 } };
        expect(parseMcpAgentItem(withIteration).metadata.iteration).toBe(2);
    });

    it.each([
        ['expectedArgs', { ...item, metadata: { ...item.metadata, expectedArgs: { actor: 'apify/rag-web-browser' } } }],
        ['expectedTools', { ...item, metadata: { ...item.metadata, expectedTools: ['search-actors'] } }],
        ['maxTurns', { ...toolCallItem, metadata: { ...toolCallItem.metadata, maxTurns: 3 } }],
        ['failTools', { ...toolCallItem, metadata: { ...toolCallItem.metadata, failTools: ['call-actor'] } }],
        ['expectedErrors', { ...toolCallItem, metadata: { ...toolCallItem.metadata, expectedErrors: ['call-actor'] } }],
    ])('rejects %s on the wrong item kind', (field, invalidItem) => {
        expect(() => parseMcpAgentItem(invalidItem)).toThrow(new RegExp(field));
    });
});

describe('toMcpAgentTestCase()', () => {
    it('flattens an item into a test case', () => {
        expect(toMcpAgentTestCase(item)).toEqual({
            id: 'a',
            category: 'search',
            kind: 'agent',
            tier: ['merge'],
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
            tier: ['merge'],
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

    it('flattens a tool-call item, dropping the absent reference and adding expectedTools/expectedArgs', () => {
        const toolCall = {
            id: 'b',
            input: { query: 'q' },
            metadata: {
                category: 'search',
                kind: 'tool-call',
                tier: ['pr'],
                expectedTools: ['search-actors'],
                expectedArgs: { actor: 'apify/rag-web-browser' },
            },
        };
        expect(toMcpAgentTestCase(toolCall)).toEqual({
            id: 'b',
            category: 'search',
            kind: 'tool-call',
            tier: ['pr'],
            query: 'q',
            expectedTools: ['search-actors'],
            expectedArgs: { actor: 'apify/rag-web-browser' },
        });
    });

    it('never exports a runner-injected iteration', () => {
        const withIteration = { ...item, metadata: { ...item.metadata, iteration: 3 } };
        expect(Object.keys(toMcpAgentTestCase(withIteration))).not.toContain('iteration');
    });
});

describe('filterByTier()', () => {
    const pr = { id: 'a', category: 'x', query: 'q', tier: ['pr'] };
    const merge = { id: 'b', category: 'x', query: 'q', tier: ['merge'] };
    const both = { id: 'c', category: 'x', query: 'q', tier: ['pr', 'merge'] };
    const cases = [pr, merge, both];

    it.each([
        ['pr', ['a', 'c']],
        ['merge', ['b', 'c']],
    ])('keeps items in the %s tier', (tier, expectedIds) => {
        expect(filterByTier(cases, tier).map((testCase) => testCase.id)).toEqual(expectedIds);
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
