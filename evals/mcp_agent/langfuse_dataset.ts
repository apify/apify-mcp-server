/**
 * Langfuse dataset mapping for MCP agent evaluations.
 *
 * The dataset is the source of truth and nothing here writes to it. An item's
 * `input.query` is the agent prompt, `expectedOutput` is what the judge scores against,
 * and `metadata` carries the harness knobs.
 */

import type { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';

/** Name of the Langfuse dataset holding the MCP agent test cases. */
export const MCP_AGENT_DATASET_NAME = 'mcp-server-evals';

/** Item shape returned by the client, derived so we don't depend on @langfuse/core. */
export type DatasetItem = Awaited<ReturnType<LangfuseClient['dataset']['get']>>['items'][number];

/**
 * The harness knobs, which live in item metadata.
 *
 * Strict: items are edited in the Langfuse UI, and a silently stripped typo (e.g.
 * `failTool`) turns off the behavior a case tests while the case still passes.
 */
const McpAgentMetadataValidator = z.strictObject({
    /** Grouping key, e.g. "search-actors". What `--category` matches on. */
    category: z.string().min(1),
    /** What this item measures: a single-turn tool pick, or a full judged conversation. */
    kind: z.enum(['selection', 'agent']),
    /** When this item runs: a fast PR-gating set, the full set, or both. */
    tier: z.array(z.enum(['pr', 'full'])).min(1),
    /** `kind: "selection"` only: tool names the first tool call must match. */
    expectedTools: z.array(z.string()).optional(),
    /**
     * `kind: "selection"` only: a flat subset of the captured call's arguments. Every key
     * here must deep-equal the same key of the captured input; keys not listed are ignored.
     */
    expectedArgs: z.record(z.string(), z.unknown()).optional(),
    /** Tool names allowed to fail on this item without failing the zero-tool-error gate. */
    expectedErrors: z.array(z.string()).optional(),
    /** Defaults to the config value. Not valid on `kind: "selection"`, which is fixed at 2. */
    maxTurns: z.number().int().positive().optional(),
    /** Tools to enable, e.g. ["actors", "docs", "apify/rag-web-browser"] */
    tools: z.array(z.string()).optional(),
    /** Tools the harness force-fails with a synthetic INTERNAL_ERROR. See mcp_client.ts. */
    failTools: z.array(z.string()).optional(),
    /** Force MCP-tools-only for this item, OR-ed with the run-wide `--mcp-tools-only` flag. */
    mcpToolsOnly: z.boolean().optional(),
    /** Runner-injected `--iterations` trial index (1-based). Never hand-authored, never exported. */
    iteration: z.number().int().positive().optional(),
});

const McpAgentItemValidator = z
    .object({
        id: z.string().min(1),
        input: z.object({ query: z.string().min(1) }),
        /**
         * Required for `kind: "agent"` (the judge's reference); absent for `kind: "selection"`.
         * The dataset-items API returns `null`, not a missing key, for an item that never set
         * it - every `kind: "selection"` item in practice - so `null` is normalized to `undefined`.
         */
        expectedOutput: z
            .string()
            .min(1)
            .nullish()
            .transform((value) => value ?? undefined),
        metadata: McpAgentMetadataValidator,
    })
    .superRefine((item, ctx) => {
        if (item.metadata.kind === 'selection' && (item.metadata.expectedTools?.length ?? 0) === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.kind "selection" requires a non-empty "expectedTools" array',
                path: ['metadata', 'expectedTools'],
            });
        }
        if (item.metadata.kind === 'agent' && !item.expectedOutput) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.kind "agent" requires a non-empty "expectedOutput"',
                path: ['expectedOutput'],
            });
        }
        if (item.metadata.kind !== 'selection' && item.metadata.expectedArgs !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.expectedArgs is only valid on a kind: "selection" item',
                path: ['metadata', 'expectedArgs'],
            });
        }
        if (item.metadata.kind === 'selection' && item.metadata.maxTurns !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.maxTurns is not valid on a kind: "selection" item; turns are fixed at 2',
                path: ['metadata', 'maxTurns'],
            });
        }
    });

/** The parts of a dataset item a run reads. */
export type McpAgentItem = z.infer<typeof McpAgentItemValidator>;

/** Flat view of an item: what the CLI filters on and what the snapshot file holds. */
export type McpAgentTestCase = z.infer<typeof McpAgentMetadataValidator> & {
    id: string;
    query: string;
    /** Absent for `kind: "selection"`, which nothing executes and no judge scores. */
    reference?: string;
};

/** A dataset item plus its flat view, so the shared filter helpers apply directly. */
export type McpAgentCase = McpAgentTestCase & { item: DatasetItem };

/**
 * Validate a dataset item before anything depends on its shape. It is UI-editable JSON,
 * so an unchecked cast would surface as a TypeError mid-run, after LLM spend.
 */
export function parseMcpAgentItem(item: unknown): McpAgentItem {
    const parsed = McpAgentItemValidator.safeParse(item);
    if (!parsed.success) {
        const id = (item as { id?: string } | null)?.id ?? '(unknown)';
        throw new Error(`Dataset item "${id}" is not a usable MCP agent test case: ${parsed.error.message}`);
    }
    return parsed.data;
}

/**
 * Flatten an item into a test case. Keys are written out rather than spread so absent
 * knobs stay absent and the exported snapshot keeps a stable key order for diffing.
 */
export function toMcpAgentTestCase(item: unknown): McpAgentTestCase {
    const { id, input, expectedOutput, metadata } = parseMcpAgentItem(item);
    return {
        id,
        category: metadata.category,
        kind: metadata.kind,
        tier: metadata.tier,
        query: input.query,
        ...(expectedOutput !== undefined && { reference: expectedOutput }),
        ...(metadata.expectedTools !== undefined && { expectedTools: metadata.expectedTools }),
        ...(metadata.expectedArgs !== undefined && { expectedArgs: metadata.expectedArgs }),
        ...(metadata.expectedErrors !== undefined && { expectedErrors: metadata.expectedErrors }),
        ...(metadata.maxTurns !== undefined && { maxTurns: metadata.maxTurns }),
        ...(metadata.tools !== undefined && { tools: metadata.tools }),
        ...(metadata.failTools !== undefined && { failTools: metadata.failTools }),
        ...(metadata.mcpToolsOnly !== undefined && { mcpToolsOnly: metadata.mcpToolsOnly }),
        // metadata.iteration is runner-injected, never hand-authored in the dataset: left out
        // here so the committed snapshot (built from toMcpAgentTestCase) stays byte-stable.
    };
}

/** Items whose `tier` array contains the given value. `--tier` filters here; absent = all. */
export function filterByTier<T extends { tier: readonly string[] }>(testCases: T[], tier: string): T[] {
    return testCases.filter((testCase) => testCase.tier.includes(tier));
}

/**
 * Every active case in the dataset, sorted by id.
 *
 * `dataset.get` returns archived items too, and archiving in the UI is how a case is
 * retired. Validating all items up front fails a malformed one before any LLM spend.
 */
export async function fetchMcpAgentCases(langfuse: LangfuseClient, datasetName: string): Promise<McpAgentCase[]> {
    const dataset = await langfuse.dataset.get(datasetName, { fetchItemsPageSize: 100 });

    return dataset.items
        .filter((item) => item.status === 'ACTIVE')
        .map((item) => ({ ...toMcpAgentTestCase(item), item }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
