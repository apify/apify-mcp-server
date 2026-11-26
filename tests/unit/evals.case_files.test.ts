import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCaseFiles, toExperimentItem } from '../../evals/runner/case_files.js';

const toolCallCase = {
    id: 'pr/search-actors/find-scraper',
    category: 'search-actors',
    kind: 'tool-call',
    query: 'Find an Actor that scrapes Google Maps',
    expectedTools: ['search-actors'],
    source: 'synthetic',
    gate: 'tracked',
};

const agentCase = {
    id: 'merge/storage/read-dataset',
    category: 'get',
    kind: 'agent',
    query: 'Show me the items of my dataset eval-storage-products',
    reference: 'PASS if the agent lists the three items.',
    source: 'bug',
    sourceNote: 'https://github.com/apify/apify-mcp-server/issues/1628',
    gate: 'blocking',
};

const tempDirs: string[] = [];

/** A fresh directory holding the given files, each written as JSON unless it is already a string. */
function makeCaseDir(files: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cases-'));
    tempDirs.push(dir);
    for (const [fileName, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, fileName), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading a case directory', () => {
    it('returns the cases of every JSON file as items, sorted by id', () => {
        const dir = makeCaseDir({
            'search-actors.json': [toolCallCase],
            'storage.json': [agentCase],
            'notes.md': '# not a case file',
        });

        expect(readCaseFiles(dir)).toEqual([
            {
                id: 'merge/storage/read-dataset',
                input: { query: 'Show me the items of my dataset eval-storage-products' },
                expectedOutput: 'PASS if the agent lists the three items.',
                metadata: {
                    category: 'get',
                    kind: 'agent',
                    source: 'bug',
                    sourceNote: 'https://github.com/apify/apify-mcp-server/issues/1628',
                    gate: 'blocking',
                },
            },
            {
                id: 'pr/search-actors/find-scraper',
                input: { query: 'Find an Actor that scrapes Google Maps' },
                expectedOutput: undefined,
                metadata: {
                    category: 'search-actors',
                    kind: 'tool-call',
                    expectedTools: ['search-actors'],
                    source: 'synthetic',
                    gate: 'tracked',
                },
            },
        ]);
    });

    it('rejects a case the item validator rejects, naming the file', () => {
        const dir = makeCaseDir({ 'search-actors.json': [{ ...toolCallCase, expectedTools: [] }] });
        expect(() => readCaseFiles(dir)).toThrow(/search-actors\.json.*expectedTools/s);
    });

    it.each(['source', 'gate'])('rejects a case without %s, which only hosted items may omit', (field) => {
        const { [field]: _omitted, ...incomplete } = toolCallCase as Record<string, unknown>;
        const dir = makeCaseDir({ 'search-actors.json': [incomplete] });
        expect(() => readCaseFiles(dir)).toThrow(new RegExp(`find-scraper.*${field}`, 's'));
    });

    it('rejects an id that appears twice, also across files', () => {
        const dir = makeCaseDir({ 'a.json': [toolCallCase], 'b.json': [toolCallCase] });
        expect(() => readCaseFiles(dir)).toThrow(/pr\/search-actors\/find-scraper.*more than once/s);
    });

    it('rejects a file that is not valid JSON, naming the file', () => {
        const dir = makeCaseDir({ 'broken.json': '[{' });
        expect(() => readCaseFiles(dir)).toThrow(/broken\.json/);
    });

    it('rejects a file that holds something other than an array', () => {
        const dir = makeCaseDir({ 'object.json': { cases: [toolCallCase] } });
        expect(() => readCaseFiles(dir)).toThrow(/object\.json.*array/s);
    });

    // An empty set copied to a dataset would archive every item in it.
    it('rejects a directory without any case', () => {
        const dir = makeCaseDir({ 'empty.json': [] });
        expect(() => readCaseFiles(dir)).toThrow(/No case/);
    });

    // A hand-written caseId would pass the item validator in place of a missing id.
    it('rejects a case that sets a runner-injected field', () => {
        const { id, ...withoutId } = toolCallCase;
        const dir = makeCaseDir({ 'search-actors.json': [{ ...withoutId, caseId: id }] });
        expect(() => readCaseFiles(dir)).toThrow(/search-actors\.json.*caseId/s);
    });
});

describe('building the experiment item of a case', () => {
    const item = {
        id: 'pr/search-actors/find-scraper',
        input: { query: 'Find an Actor that scrapes Google Maps' },
        expectedOutput: undefined,
        metadata: { category: 'search-actors', kind: 'tool-call' as const, expectedTools: ['search-actors'] },
    };

    // With an `id`, the Langfuse client would try to link the run to a hosted dataset item.
    it('moves the id to metadata.caseId when the run is not linked to a dataset', () => {
        const experimentItem = toExperimentItem(item);

        expect(experimentItem).not.toHaveProperty('id');
        expect(experimentItem).not.toHaveProperty('datasetId');
        expect(experimentItem.metadata).toEqual({ ...item.metadata, caseId: 'pr/search-actors/find-scraper' });
        expect(experimentItem.input).toEqual(item.input);
    });

    // The client links an item to a dataset run only when it carries both.
    it('keeps the id and adds the dataset id when the run is linked', () => {
        expect(toExperimentItem(item, 'dataset-123')).toEqual({ ...item, datasetId: 'dataset-123' });
    });
});
