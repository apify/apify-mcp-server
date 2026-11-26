/**
 * Langfuse dataset mapping for MCP agent evaluations.
 *
 * Nothing in this file writes to a dataset; `dataset_copy.ts` does, under `--link-dataset`. An item's
 * `input.query` is the agent prompt, `expectedOutput` is what the judge scores against,
 * and `metadata` carries the harness knobs.
 */

import type { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';

/**
 * The tool-call items that gate PRs, and the CLI's default. The judged agent items live in
 * `mcp-server-evals-merge`, selected with `--dataset`.
 */
export const MCP_AGENT_PR_DATASET_NAME = 'mcp-server-evals-pr';

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
    /**
     * What this item measures. `tool-call`: only the first attempted tool call is asserted,
     * by name and optional args; no judge, nothing executes. `agent`: full multi-turn run,
     * an LLM judge scores against `expectedOutput`.
     */
    kind: z.enum(['tool-call', 'agent']),
    /** `kind: "tool-call"` only: tool names the first tool call must match. */
    expectedTools: z.array(z.string()).optional(),
    /**
     * `kind: "tool-call"` only: a flat subset of the captured call's arguments. Every key
     * here must deep-equal the same key of the captured input; keys not listed are ignored.
     */
    expectedArgs: z.record(z.string(), z.unknown()).optional(),
    /** Tool names allowed to fail on this item without failing the zero-tool-error gate. */
    expectedErrors: z.array(z.string()).optional(),
    /** Defaults to `MAX_CONVERSATION_TURNS`. Not valid on `kind: "tool-call"`, which is fixed at 2. */
    maxTurns: z.number().int().positive().optional(),
    /** Tools to enable, e.g. ["actors", "docs", "apify/rag-web-browser"] */
    tools: z.array(z.string()).optional(),
    /** Tools the harness refuses via a PreToolUse deny with a failure message. See denyToolsHook() in agent/claude_agent.ts. */
    failTools: z.array(z.string()).optional(),
    /** Force MCP-tools-only for this item, OR-ed with the run-wide `--mcp-tools-only` flag. */
    mcpToolsOnly: z.boolean().optional(),
    /** Runner-injected `--iterations` trial index (1-based). Never hand-authored, never exported. */
    iteration: z.number().int().positive().optional(),
    /**
     * Where the case came from: a sanitised production trace, a bug report or issue, a person
     * who can say why it is hard, or generated. Required in case files; items of the hosted
     * datasets were written before the field existed.
     */
    source: z.enum(['production', 'bug', 'hand', 'synthetic']).optional(),
    /** The issue link or the one-line reason behind `source`. */
    sourceNote: z.string().min(1).optional(),
    /**
     * `blocking`: a case a release must not break. `tracked`: reported but tolerated, e.g. a
     * known failure waiting for a fix. Required in case files; a hosted item without it
     * counts as tracked.
     */
    gate: z.enum(['blocking', 'tracked']).optional(),
    /**
     * Runner-injected id of a case-file item in a run that is not linked to a dataset. Such an
     * item must not carry `id`: the Langfuse client reads `id` as a hosted dataset item id and
     * tries to link the run to it. Never hand-authored, never exported.
     */
    caseId: z.string().min(1).optional(),
});

const McpAgentItemValidator = z
    .object({
        id: z.string().min(1).optional(),
        input: z.object({ query: z.string().min(1) }),
        /**
         * Required for `kind: "agent"` (the judge's reference); absent for `kind: "tool-call"`.
         * The dataset-items API returns `null`, not a missing key, for an item that never set
         * it - every `kind: "tool-call"` item in practice - so `null` is normalized to `undefined`.
         */
        expectedOutput: z
            .string()
            .min(1)
            .nullish()
            .transform((value) => value ?? undefined),
        metadata: McpAgentMetadataValidator,
    })
    .superRefine((item, ctx) => {
        if (item.id === undefined && item.metadata.caseId === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'an item needs an "id" or a "metadata.caseId"',
                path: ['id'],
            });
        }
        if (item.metadata.kind === 'tool-call' && (item.metadata.expectedTools?.length ?? 0) === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.kind "tool-call" requires a non-empty "expectedTools" array',
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
        if (item.metadata.kind !== 'tool-call' && item.metadata.expectedArgs !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.expectedArgs is only valid on a kind: "tool-call" item',
                path: ['metadata', 'expectedArgs'],
            });
        }
        // Nothing scores expectedTools on an agent item, so accepting one would silently drop
        // the assertion its author wrote.
        if (item.metadata.kind !== 'tool-call' && item.metadata.expectedTools !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.expectedTools is only valid on a kind: "tool-call" item',
                path: ['metadata', 'expectedTools'],
            });
        }
        if (item.metadata.kind === 'tool-call' && item.metadata.maxTurns !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.maxTurns is not valid on a kind: "tool-call" item; turns are fixed at 2',
                path: ['metadata', 'maxTurns'],
            });
        }
        if (item.metadata.kind === 'tool-call' && item.expectedOutput !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'expectedOutput is not valid on a kind: "tool-call" item; there is no judge to read it',
                path: ['expectedOutput'],
            });
        }
        if (item.metadata.kind === 'tool-call' && item.metadata.failTools !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.failTools is only valid on a kind: "agent" item',
                path: ['metadata', 'failTools'],
            });
        }
        if (item.metadata.kind === 'tool-call' && item.metadata.expectedErrors !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'metadata.expectedErrors is only valid on a kind: "agent" item',
                path: ['metadata', 'expectedErrors'],
            });
        }
    })
    // The check above guarantees one of the two; a transform does not run on an item with issues.
    .transform((item) => ({ ...item, id: item.id ?? (item.metadata.caseId as string) }));

/** The parts of a dataset item a run reads. */
export type McpAgentItem = z.infer<typeof McpAgentItemValidator>;

/** Flat view of an item: what the CLI filters on and what the snapshot file holds. */
export type McpAgentTestCase = z.infer<typeof McpAgentMetadataValidator> & {
    id: string;
    query: string;
    /** Absent for `kind: "tool-call"`, which nothing executes and no judge scores. */
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
        query: input.query,
        ...(expectedOutput !== undefined && { reference: expectedOutput }),
        ...(metadata.expectedTools !== undefined && { expectedTools: metadata.expectedTools }),
        ...(metadata.expectedArgs !== undefined && { expectedArgs: metadata.expectedArgs }),
        ...(metadata.expectedErrors !== undefined && { expectedErrors: metadata.expectedErrors }),
        ...(metadata.maxTurns !== undefined && { maxTurns: metadata.maxTurns }),
        ...(metadata.tools !== undefined && { tools: metadata.tools }),
        ...(metadata.failTools !== undefined && { failTools: metadata.failTools }),
        ...(metadata.mcpToolsOnly !== undefined && { mcpToolsOnly: metadata.mcpToolsOnly }),
        ...(metadata.source !== undefined && { source: metadata.source }),
        ...(metadata.sourceNote !== undefined && { sourceNote: metadata.sourceNote }),
        ...(metadata.gate !== undefined && { gate: metadata.gate }),
        // metadata.iteration and metadata.caseId are runner-injected, never hand-authored: left
        // out here so the committed snapshot (built from toMcpAgentTestCase) stays byte-stable.
    };
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
