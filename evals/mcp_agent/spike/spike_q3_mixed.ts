#!/usr/bin/env node
/* eslint-disable */
/**
 * SPIKE (throwaway) — Q3: can a single experiment.run() mix a deny-all item and a normal
 * (executing) item, since hooks are configured per item's agent instance (per query() call)?
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

const STDIO_BIN_PATH = resolve(process.cwd(), 'dist/stdio.js');
if (!existsSync(STDIO_BIN_PATH)) throw new Error(`missing ${STDIO_BIN_PATH}, run pnpm run build`);
delete process.env.ANTHROPIC_API_KEY;

function denyAllHook(captures: { toolName: string; toolInput: unknown }[]): HookCallbackMatcher[] {
    return [
        {
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
                    captures.push({ toolName: input.tool_name, toolInput: input.tool_input });
                    return {
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: 'Tool calls are disabled in this evaluation. Report which tool you would have called, then stop.',
                        },
                    };
                },
            ],
        },
    ];
}

type Item = { id: string; prompt: string; denyAll: boolean };

async function runOne(item: Item) {
    const denyCaptures: { toolName: string; toolInput: unknown }[] = [];
    const executedToolResults: { name: string; success: boolean }[] = [];
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
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 4,
        cwd: tmpdir(),
        abortController,
        // denyAll item: PreToolUse hook denies before any permission check.
        // normal item: no bypassPermissions available as root (see Q1) - approve everything
        // via canUseTool instead, so this item actually executes its tool call for real.
        ...(item.denyAll
            ? { hooks: { PreToolUse: denyAllHook(denyCaptures) } }
            : { canUseTool: async (_name: string, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input }) as any }),
    };

    let finalText = '';
    let numTurns: number | undefined;
    for await (const message of query({ prompt: item.prompt, options: sdkOptions })) {
        if (message.type === 'user') {
            for (const block of (message as any).message?.content ?? []) {
                if (block?.type === 'tool_result') {
                    executedToolResults.push({ name: 'tool_result', success: block.is_error !== true });
                }
            }
        }
        if (message.type === 'result') {
            numTurns = (message as any).num_turns;
            if ((message as any).subtype === 'success') finalText = (message as any).result;
            break;
        }
    }
    abortController.abort();
    return { id: item.id, denyAll: item.denyAll, denyCaptures, executedToolResults, numTurns, finalText };
}

async function main() {
    const items: Item[] = [
        { id: 'mixed-a-deny', prompt: 'Search Apify for a TikTok scraper Actor.', denyAll: true },
        { id: 'mixed-b-normal', prompt: 'Search Apify for a TikTok scraper Actor and name the top result.', denyAll: false },
    ];

    // Concurrent, like the real harness under maxConcurrency>1: each item gets its own
    // agent + MCP server + hook config, run in parallel.
    const results = await Promise.all(items.map(runOne));
    console.log(JSON.stringify(results, null, 2));
}

void main();
