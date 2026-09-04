#!/usr/bin/env node
/* eslint-disable */
/**
 * SPIKE (throwaway) — Q1: deny-ALL PreToolUse hook capture probe.
 *
 * Standalone, does not go through langfuse_experiment.ts / the judge / Langfuse at all.
 * Runs runAgentConversation-equivalent logic directly against the SDK so we can inspect
 * exactly what the hook sees and what the agent does after every single tool call is denied.
 *
 * Usage: node --import tsx evals/mcp_agent/spike/spike_q1_deny_all.ts
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { HookCallbackMatcher, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

const STDIO_BIN_PATH = resolve(process.cwd(), 'dist/stdio.js');
if (!existsSync(STDIO_BIN_PATH)) throw new Error(`missing ${STDIO_BIN_PATH}, run pnpm run build`);

// Subscription mode: no ANTHROPIC_API_KEY in env (matches --subscription in the real runner).
delete process.env.ANTHROPIC_API_KEY;

type DenyCapture = {
    toolName: string;
    toolInput: unknown;
    capturedAtMs: number;
    order: number;
};

/** Deny-ALL PreToolUse hook. Records every attempted call and denies it with `reasonText`. */
function denyAllHook(reasonText: string, captures: DenyCapture[]): HookCallbackMatcher[] {
    let order = 0;
    return [
        {
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
                    captures.push({
                        toolName: input.tool_name,
                        toolInput: input.tool_input,
                        capturedAtMs: Date.now(),
                        order: order++,
                    });
                    return {
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: reasonText,
                        },
                    };
                },
            ],
        },
    ];
}

type RunResult = {
    label: string;
    query: string;
    denialWording: string;
    denyCaptures: DenyCapture[];
    assistantToolUseFromStream: { name: string; input: unknown }[];
    numTurns?: number;
    resultSubtype?: string;
    durationMs?: number;
    totalCostUsd?: number;
    usage?: unknown;
    finalResultText?: string;
    rawMessageTypeSequence: string[];
};

async function runOne(label: string, prompt: string, denialWording: string, maxTurns: number): Promise<RunResult> {
    const denyCaptures: DenyCapture[] = [];
    const assistantToolUseFromStream: { name: string; input: unknown }[] = [];
    const rawMessageTypeSequence: string[] = [];

    const abortController = new AbortController();
    const sdkOptions: Options = {
        model: 'claude-haiku-4-5',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        mcpServers: {
            apify: {
                type: 'stdio',
                command: 'node',
                args: [STDIO_BIN_PATH],
                env: { ...process.env, APIFY_TOKEN: process.env.APIFY_TOKEN ?? '' },
                timeout: 60000,
                alwaysLoad: true,
            },
        },
        // NOTE (spike finding): 'bypassPermissions' + allowDangerouslySkipPermissions is what
        // claude_agent.ts uses in production, but the underlying CLI hard-refuses
        // --dangerously-skip-permissions when running as root/sudo ("cannot be used with
        // root/sudo privileges for security reasons") -- this sandbox runs as root, and
        // IS_SANDBOX=yes does not override that check. Left at 'default' here: the PreToolUse
        // deny-all hook fires before the permission/canUseTool layer anyway, so every tool call
        // is denied before a prompt would ever be needed. See report Q1 "sandbox blocker".
        settingSources: [],
        strictMcpConfig: true,
        maxTurns,
        cwd: tmpdir(),
        abortController,
        hooks: { PreToolUse: denyAllHook(denialWording, denyCaptures) },
        stderr: (data: string) => process.stderr.write(`[claude-stderr] ${data}`),
    };

    let numTurns: number | undefined;
    let resultSubtype: string | undefined;
    let durationMs: number | undefined;
    let totalCostUsd: number | undefined;
    let usage: unknown;
    let finalResultText: string | undefined;

    try {
        for await (const message of query({ prompt, options: sdkOptions })) {
            rawMessageTypeSequence.push((message as SDKMessage).type + (('subtype' in message && (message as any).subtype) ? `:${(message as any).subtype}` : ''));
            if (message.type === 'assistant') {
                const content = (message as any).message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block?.type === 'tool_use') {
                            assistantToolUseFromStream.push({ name: block.name, input: block.input });
                        }
                    }
                }
            }
            if (message.type === 'result') {
                numTurns = (message as any).num_turns;
                resultSubtype = (message as any).subtype;
                durationMs = (message as any).duration_ms;
                totalCostUsd = (message as any).total_cost_usd;
                usage = (message as any).usage;
                if ((message as any).subtype === 'success') finalResultText = (message as any).result;
                // On error_max_turns the SDK's underlying process exits non-zero right after
                // this message and further iteration of the stream throws a spurious
                // "Claude Code returned an error result" -- we already have everything we need.
                break;
            }
        }
    } finally {
        abortController.abort();
    }

    return {
        label,
        query: prompt,
        denialWording,
        denyCaptures,
        assistantToolUseFromStream,
        numTurns,
        resultSubtype,
        durationMs,
        totalCostUsd,
        usage,
        finalResultText,
        rawMessageTypeSequence,
    };
}

const QUERIES = [
    'What is the best TikTok scraper on Apify?',
    'Show me the input schema for apify/rag-web-browser',
    'Fetch https://example.com and tell me what it says',
];

const WORDING_CLEAN_STOP = 'Tool calls are disabled in this evaluation. Do not retry with a different tool or arguments — report to the user, in your final answer, which tool you would have called and with what arguments, then stop.';
const WORDING_NUDGE_STYLE = 'The tool failed with an internal error.\n\nIf you cannot resolve this yourself, report it to the Apify team by calling report-problem (describe what you were doing and this error) before telling the user you could not complete the task.';

async function main() {
    const results: RunResult[] = [];

    // Phase A: clean-stop wording, all 3 queries, maxTurns=3.
    for (const [i, q] of QUERIES.entries()) {
        console.error(`\n=== A${i + 1}: clean-stop wording — "${q}" ===`);
        const r = await runOne(`A${i + 1}-clean-stop`, q, WORDING_CLEAN_STOP, 3);
        results.push(r);
        console.error(JSON.stringify(r, null, 2));
    }

    // Phase B: nudge-style wording (mirrors failTools' REPORT_PROBLEM_NUDGE), same 3 queries,
    // to compare whether the agent burns turns retrying / calling report-problem.
    for (const [i, q] of QUERIES.entries()) {
        console.error(`\n=== B${i + 1}: nudge-style wording — "${q}" ===`);
        const r = await runOne(`B${i + 1}-nudge-style`, q, WORDING_NUDGE_STYLE, 3);
        results.push(r);
        console.error(JSON.stringify(r, null, 2));
    }

    console.log('\n\n=== FINAL JSON DUMP ===');
    console.log(JSON.stringify(results, null, 2));
}

void main();
