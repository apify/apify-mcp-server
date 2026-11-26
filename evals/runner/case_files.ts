/** Reads eval cases from JSON files and turns them into the items an experiment runs on. */

import fs from 'node:fs';
import path from 'node:path';

import type { McpAgentItem } from '../langfuse/dataset.js';
import { parseMcpAgentItem } from '../langfuse/dataset.js';

/**
 * One entry of a case file: the flat shape `toMcpAgentTestCase()` writes. Validated as the item
 * it stands for, so a case file and a hosted item obey the same rules. `source` and `gate` are
 * required here although the item validator leaves them optional for hosted items.
 */
function parseCaseFileEntry(entry: unknown, filePath: string): McpAgentItem {
    if (typeof entry !== 'object' || entry === null) {
        throw new Error(`Case file "${filePath}" holds an entry that is not an object`);
    }
    const { id, query, reference, ...metadata } = entry as Record<string, unknown>;
    // Runner-injected: a hand-written `caseId` would stand in for a missing `id`.
    for (const field of ['iteration', 'caseId']) {
        if (field in metadata) throw new Error(`Case file "${filePath}": case "${String(id)}" sets "${field}"`);
    }
    let item: McpAgentItem;
    try {
        item = parseMcpAgentItem({ id, input: { query }, expectedOutput: reference, metadata });
    } catch (error) {
        throw new Error(`Case file "${filePath}": ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        });
    }
    for (const field of ['source', 'gate'] as const) {
        if (item.metadata[field] === undefined) {
            throw new Error(`Case file "${filePath}": case "${item.id}" has no "${field}"`);
        }
    }
    return item;
}

/**
 * Every case in the `*.json` files of `dir`, sorted by id. Each file is a JSON array.
 *
 * Throws on a malformed file, an invalid case, a repeated id or a directory without cases, so
 * a bad file fails the run before any LLM spend and before anything is copied to a dataset.
 */
export function readCaseFiles(dir: string): McpAgentItem[] {
    const fileNames = fs.readdirSync(dir).filter((fileName) => fileName.endsWith('.json'));

    const items = fileNames.flatMap((fileName) => {
        const filePath = path.join(dir, fileName);
        let entries: unknown;
        try {
            entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            throw new Error(
                `Case file "${filePath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
        if (!Array.isArray(entries)) throw new Error(`Case file "${filePath}" must hold a JSON array of cases`);
        return entries.map((entry) => parseCaseFileEntry(entry, filePath));
    });

    if (items.length === 0) throw new Error(`No case found in the *.json files of "${dir}"`);

    const seenIds = new Set<string>();
    for (const { id } of items) {
        if (seenIds.has(id)) throw new Error(`Case id "${id}" appears more than once in "${dir}"`);
        seenIds.add(id);
    }

    return items.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The item `experiment.run` gets for a case-file item.
 *
 * Linked to a dataset (`datasetId` given): the item keeps its `id` and gains `datasetId`. The
 * Langfuse client attaches an item to a dataset run only when it carries both.
 *
 * Not linked: the `id` moves to `metadata.caseId`. The client reads any `id` as a hosted dataset
 * item id, links the run when that id exists in some dataset and logs a 404 when it does not.
 */
export function toExperimentItem(item: McpAgentItem, datasetId?: string) {
    if (datasetId !== undefined) return { ...item, datasetId };
    const { id, ...rest } = item;
    return { ...rest, metadata: { ...rest.metadata, caseId: id } };
}
