/**
 * Generate one Harbor task directory per test case.
 *
 * test_cases.json stays the single source of truth. For each case the generator emits a task
 * dir: instruction.md (the query), task.toml (metadata + prebuilt image + timeouts), tests/
 * (the verifier script + per-case config the judge reads), and an empty environment/ (the
 * prebuilt image needs no Dockerfile). The mapping is pure so it can be unit-tested; disk
 * writes live in writeTaskDir().
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DOCKER_IMAGE_TAG, MAX_CONVERSATION_TURNS } from './config.js';
import { HARNESS } from './harness.js';
import type { WorkflowTestCase } from './test_cases_loader.js';

/** Absolute path of the built MCP server + eval runner inside the prebuilt image. */
const APP_DIR = '/app';

/** Delimiters for the machine-readable config appended to a ts-executor instruction. */
const CONFIG_MARKER_PREFIX = '<!--EVAL_CONFIG ';
const CONFIG_MARKER_SUFFIX = '-->';

/** Per-case agent config carried in the ts-executor instruction. */
export type InstructionConfig = {
    tools?: string[];
    failTools?: string[];
    maxTurns?: number;
};

/** Parsed ts-executor instruction: the clean query plus its embedded config. */
export type ParsedInstruction = {
    query: string;
    config: InstructionConfig;
};

/**
 * Build the instruction text for a task. claude-code sees the bare query (its MCP toolset comes
 * from task.toml). ts-executor gets the query plus a trailing HTML-comment config block the
 * entrypoint parses. That block is the only per-task channel a custom agent has beyond the query.
 */
export function buildInstruction(testCase: WorkflowTestCase, harness: HARNESS): string {
    if (harness !== HARNESS.TS_EXECUTOR) {
        return testCase.query;
    }
    const config: InstructionConfig = {
        ...(testCase.tools ? { tools: testCase.tools } : {}),
        ...(testCase.failTools ? { failTools: testCase.failTools } : {}),
        maxTurns: testCase.maxTurns ?? MAX_CONVERSATION_TURNS,
    };
    return `${testCase.query}\n\n${CONFIG_MARKER_PREFIX}${JSON.stringify(config)}${CONFIG_MARKER_SUFFIX}`;
}

/** Parse a ts-executor instruction back into its query and config (inverse of buildInstruction). */
export function parseInstruction(instruction: string): ParsedInstruction {
    const markerStart = instruction.indexOf(CONFIG_MARKER_PREFIX);
    if (markerStart === -1) {
        return { query: instruction.trim(), config: {} };
    }
    const jsonStart = markerStart + CONFIG_MARKER_PREFIX.length;
    const jsonEnd = instruction.indexOf(CONFIG_MARKER_SUFFIX, jsonStart);
    if (jsonEnd === -1) {
        return { query: instruction.trim(), config: {} };
    }
    return {
        query: instruction.slice(0, markerStart).trim(),
        config: JSON.parse(instruction.slice(jsonStart, jsonEnd)) as InstructionConfig,
    };
}

/** A generated task, as a map of task-relative file path to file content. */
export type TaskFiles = Record<string, string>;

export type BuildTaskFilesOptions = {
    testCase: WorkflowTestCase;
    harness: HARNESS;
    toolTimeoutSeconds: number;
};

/** Escape a string for a double-quoted TOML value. */
function tomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render the MCP server block for claude-code (ts-executor spawns its own server). */
function buildMcpServerBlock(testCase: WorkflowTestCase): string {
    const args = [`${APP_DIR}/dist/stdio.js`];
    if (testCase.tools && testCase.tools.length > 0) {
        args.push(`--tools=${testCase.tools.join(',')}`);
    }
    const argsToml = args.map(tomlString).join(', ');
    return [
        '[[environment.mcp_servers]]',
        'name = "apify"',
        'transport = "stdio"',
        'command = "node"',
        `args = [${argsToml}]`,
    ].join('\n');
}

/** Build task.toml. Agent timeout scales with the turn budget and tool timeout. */
export function buildTaskConfig(options: BuildTaskFilesOptions): string {
    const { testCase, harness, toolTimeoutSeconds } = options;
    const maxTurns = testCase.maxTurns ?? MAX_CONVERSATION_TURNS;
    const agentTimeoutSec = maxTurns * (toolTimeoutSeconds + 30) + 180;

    const sections = [
        'schema_version = "1.3"',
        ['[task]', `name = ${tomlString(`apify-workflow-evals/${testCase.id}`)}`].join('\n'),
        ['[metadata]', `category = ${tomlString(testCase.category)}`, `harness = ${tomlString(harness)}`].join('\n'),
        ['[agent]', `timeout_sec = ${agentTimeoutSec}`].join('\n'),
        ['[verifier]', 'timeout_sec = 300'].join('\n'),
        ['[environment]', `docker_image = ${tomlString(DOCKER_IMAGE_TAG)}`, 'network_mode = "public"'].join('\n'),
    ];

    if (harness === HARNESS.CLAUDE_CODE) {
        sections.push(buildMcpServerBlock(testCase));
    }

    return `${sections.join('\n\n')}\n`;
}

/** The verifier script. Runs the shared judge over the ATIF trajectory the agent left behind. */
export const TEST_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
export PATH="${APP_DIR}/node_modules/.bin:$PATH"
cd ${APP_DIR}
tsx evals/workflows/run_judge.ts \\
  --trajectory /logs/agent/trajectory.json \\
  --case /tests/case.json \\
  --reward-json /logs/verifier/reward.json
`;

/** The per-case config the verifier reads (the judge needs the reference). */
export function buildCaseJson(testCase: WorkflowTestCase): string {
    return `${JSON.stringify({ id: testCase.id, category: testCase.category, reference: testCase.reference ?? '' }, null, 2)}\n`;
}

/** Build every file for a task, keyed by task-relative path. */
export function buildTaskFiles(options: BuildTaskFilesOptions): TaskFiles {
    const { testCase, harness } = options;
    return {
        'instruction.md': `${buildInstruction(testCase, harness)}\n`,
        'task.toml': buildTaskConfig(options),
        'tests/test.sh': TEST_SCRIPT,
        'tests/case.json': buildCaseJson(testCase),
        'environment/.gitkeep': '',
    };
}

/**
 * Split cases into those the harness can run and those it must skip. failTools relies on the
 * TS harness's synthetic-failure injection, which claude-code cannot reproduce, so failTools
 * cases are skipped under claude-code (the orchestrator logs the skip visibly).
 */
export function partitionForHarness(
    testCases: WorkflowTestCase[],
    harness: HARNESS,
): { runnable: WorkflowTestCase[]; skipped: WorkflowTestCase[] } {
    if (harness !== HARNESS.CLAUDE_CODE) {
        return { runnable: testCases, skipped: [] };
    }
    const runnable: WorkflowTestCase[] = [];
    const skipped: WorkflowTestCase[] = [];
    for (const testCase of testCases) {
        if (testCase.failTools && testCase.failTools.length > 0) {
            skipped.push(testCase);
        } else {
            runnable.push(testCase);
        }
    }
    return { runnable, skipped };
}

/** Write one task directory to disk (creates parents, marks the test script executable). */
export function writeTaskDir(tasksRoot: string, options: BuildTaskFilesOptions): string {
    const taskDir = path.join(tasksRoot, options.testCase.id);
    const files = buildTaskFiles(options);
    for (const [relPath, content] of Object.entries(files)) {
        const filePath = path.join(taskDir, relPath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, relPath === 'tests/test.sh' ? { mode: 0o755 } : undefined);
    }
    return taskDir;
}

/** Remove and recreate the tasks root so each run starts from a clean, regenerated set. */
export function resetTasksRoot(tasksRoot: string): void {
    rmSync(tasksRoot, { recursive: true, force: true });
    mkdirSync(tasksRoot, { recursive: true });
}
