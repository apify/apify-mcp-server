import { describe, expect, it } from 'vitest';

import { HARNESS } from '../../evals/workflows/harness.js';
import {
    buildCaseJson,
    buildInstruction,
    buildTaskConfig,
    parseInstruction,
    partitionForHarness,
} from '../../evals/workflows/task_generator.js';
import type { WorkflowTestCase } from '../../evals/workflows/test_cases_loader.js';

const baseCase: WorkflowTestCase = {
    id: 'search-google-maps',
    category: 'search',
    query: 'Is there any Google Maps scraping tool on Apify?',
    reference: 'The agent must search for Google Maps actors.',
};

const configuredCase: WorkflowTestCase = {
    ...baseCase,
    id: 'report-problem-on-tool-error',
    category: 'report-problem',
    tools: ['actors', 'report-problem'],
    failTools: ['call-actor'],
    maxTurns: 8,
};

describe('buildInstruction()', () => {
    it('returns the bare query for the claude-code harness', () => {
        expect(buildInstruction(baseCase, HARNESS.CLAUDE_CODE)).toBe(baseCase.query);
    });

    it('appends a config marker for the ts-executor harness', () => {
        const instruction = buildInstruction(configuredCase, HARNESS.TS_EXECUTOR);
        expect(instruction.startsWith(configuredCase.query)).toBe(true);
        expect(instruction).toContain('<!--EVAL_CONFIG ');
    });
});

describe('parseInstruction()', () => {
    it('round-trips the ts-executor query and config', () => {
        const parsed = parseInstruction(buildInstruction(configuredCase, HARNESS.TS_EXECUTOR));
        expect(parsed.query).toBe(configuredCase.query);
        expect(parsed.config).toEqual({ tools: ['actors', 'report-problem'], failTools: ['call-actor'], maxTurns: 8 });
    });

    it('defaults maxTurns when a case does not set it', () => {
        const parsed = parseInstruction(buildInstruction(baseCase, HARNESS.TS_EXECUTOR));
        expect(parsed.config).toEqual({ maxTurns: 10 });
    });

    it('returns an empty config when there is no marker', () => {
        expect(parseInstruction('just a query')).toEqual({ query: 'just a query', config: {} });
    });
});

describe('partitionForHarness()', () => {
    it('skips failTools cases under claude-code', () => {
        const { runnable, skipped } = partitionForHarness([baseCase, configuredCase], HARNESS.CLAUDE_CODE);
        expect(runnable.map((testCase) => testCase.id)).toEqual(['search-google-maps']);
        expect(skipped.map((testCase) => testCase.id)).toEqual(['report-problem-on-tool-error']);
    });

    it('runs every case under ts-executor', () => {
        const { runnable, skipped } = partitionForHarness([baseCase, configuredCase], HARNESS.TS_EXECUTOR);
        expect(runnable).toHaveLength(2);
        expect(skipped).toHaveLength(0);
    });
});

describe('buildTaskConfig()', () => {
    it('references the prebuilt image and scales the agent timeout with the turn budget', () => {
        const toml = buildTaskConfig({
            testCase: configuredCase,
            harness: HARNESS.TS_EXECUTOR,
            toolTimeoutSeconds: 60,
        });
        expect(toml).toContain('docker_image = "apify-mcp-evals:local"');
        // 8 turns * (60 + 30) + 180 = 900
        expect(toml).toContain('timeout_sec = 900');
    });

    it('adds an MCP server block with the tool list for claude-code', () => {
        const toml = buildTaskConfig({
            testCase: configuredCase,
            harness: HARNESS.CLAUDE_CODE,
            toolTimeoutSeconds: 60,
        });
        expect(toml).toContain('[[environment.mcp_servers]]');
        expect(toml).toContain('--tools=actors,report-problem');
    });

    it('omits the MCP server block for ts-executor (it spawns its own server)', () => {
        const toml = buildTaskConfig({
            testCase: configuredCase,
            harness: HARNESS.TS_EXECUTOR,
            toolTimeoutSeconds: 60,
        });
        expect(toml).not.toContain('mcp_servers');
    });
});

describe('buildCaseJson()', () => {
    it('carries the id and reference the verifier needs', () => {
        const parsed = JSON.parse(buildCaseJson(baseCase));
        expect(parsed).toEqual({ id: baseCase.id, category: baseCase.category, reference: baseCase.reference });
    });
});
