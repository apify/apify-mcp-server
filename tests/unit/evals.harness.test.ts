import { describe, expect, it } from 'vitest';

import {
    buildEnvPassthroughArgs,
    buildHarborRunArgs,
    HARNESS,
    resolveAgentModel,
    resolveHarborAgent,
    TS_EXECUTOR_AGENT_IMPORT_PATH,
} from '../../evals/workflows/harness.js';

describe('resolveHarborAgent()', () => {
    it('maps claude-code to the built-in agent name', () => {
        expect(resolveHarborAgent(HARNESS.CLAUDE_CODE)).toBe('claude-code');
    });

    it('maps ts-executor to the custom agent import path', () => {
        expect(resolveHarborAgent(HARNESS.TS_EXECUTOR)).toBe(TS_EXECUTOR_AGENT_IMPORT_PATH);
    });
});

describe('resolveAgentModel()', () => {
    it('defaults claude-code to the native Anthropic id (dash form)', () => {
        expect(resolveAgentModel(HARNESS.CLAUDE_CODE)).toBe('claude-haiku-4-5');
    });

    it('defaults ts-executor to the OpenRouter slug', () => {
        expect(resolveAgentModel(HARNESS.TS_EXECUTOR)).toBe('anthropic/claude-haiku-4.5');
    });

    it('passes an explicit model through verbatim for either harness', () => {
        expect(resolveAgentModel(HARNESS.CLAUDE_CODE, 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
        expect(resolveAgentModel(HARNESS.TS_EXECUTOR, 'openai/gpt-5')).toBe('openai/gpt-5');
    });
});

describe('buildHarborRunArgs()', () => {
    it('maps paths, agent, model, and concurrency to harbor flags', () => {
        const args = buildHarborRunArgs({
            harness: HARNESS.TS_EXECUTOR,
            tasksDir: '/tasks',
            jobsDir: '/jobs',
            agentModel: 'anthropic/claude-haiku-4.5',
            concurrency: 8,
        });
        expect(args).toEqual([
            'run',
            '-p',
            '/tasks',
            '-o',
            '/jobs',
            '-e',
            'docker',
            '-a',
            TS_EXECUTOR_AGENT_IMPORT_PATH,
            '-m',
            'anthropic/claude-haiku-4.5',
            '-n',
            '8',
            '-y',
        ]);
    });
});

describe('buildEnvPassthroughArgs()', () => {
    const base = {
        apifyToken: 'apify-token',
        openrouterKey: 'or-key',
        judgeModel: 'deepseek/deepseek-v4-flash',
        toolTimeoutSeconds: 60,
    };

    it('passes the Anthropic key to claude-code agents', () => {
        const args = buildEnvPassthroughArgs({ ...base, harness: HARNESS.CLAUDE_CODE, anthropicKey: 'ant-key' });
        expect(args).toContain('ANTHROPIC_API_KEY=ant-key');
        expect(args).toContain('APIFY_TOKEN=apify-token');
        expect(args).toContain('EVAL_JUDGE_MODEL=deepseek/deepseek-v4-flash');
    });

    it('does not pass the Anthropic key to ts-executor agents', () => {
        const args = buildEnvPassthroughArgs({ ...base, harness: HARNESS.TS_EXECUTOR, anthropicKey: 'ant-key' });
        expect(args).not.toContain('ANTHROPIC_API_KEY=ant-key');
    });

    it('gives the agent the tool timeout but not the verifier (the judge runs no MCP tools)', () => {
        const args = buildEnvPassthroughArgs({ ...base, harness: HARNESS.TS_EXECUTOR });
        const aeValues = args.filter((_, index) => args[index - 1] === '--ae');
        const veValues = args.filter((_, index) => args[index - 1] === '--ve');
        expect(aeValues).toContain('EVAL_TOOL_TIMEOUT_SECONDS=60');
        expect(veValues).toEqual(['OPENROUTER_API_KEY=or-key', 'EVAL_JUDGE_MODEL=deepseek/deepseek-v4-flash']);
    });
});
