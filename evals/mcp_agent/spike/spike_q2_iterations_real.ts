#!/usr/bin/env node
/* eslint-disable */
/**
 * SPIKE (throwaway) — Q2 Phase 2: confirm the "repeat item N times in data[]" iteration
 * shape holds with a REAL Claude Code agent task (not the fake counter), 2 dataset items x
 * 2 iterations = 4 real agent invocations. No judge (per spike instructions) — a trivial
 * evaluator just records which iteration + a hash of the agent's answer, to prove the 4
 * runs are independent (different answers/traces) rather than 1 cached result reused 4x.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { LangfuseClient } from '@langfuse/client';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { initTracing, shutdownTracing } from '../langfuse_tracing.js';

const DATASET_NAME = 'zz-spike-selection-poc';
const STDIO_BIN_PATH = resolve(process.cwd(), 'dist/stdio.js');
if (!existsSync(STDIO_BIN_PATH)) throw new Error(`missing ${STDIO_BIN_PATH}, run pnpm run build`);
delete process.env.ANTHROPIC_API_KEY;

async function runRealAgent(prompt: string): Promise<string> {
    const abortController = new AbortController();
    const sdkOptions: Options = {
        model: 'claude-haiku-4-5',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: [],
        maxTurns: 1,
        cwd: tmpdir(),
        abortController,
        settingSources: [],
    };
    let finalText = '';
    try {
        for await (const message of query({ prompt, options: sdkOptions })) {
            if (message.type === 'result') {
                if ((message as any).subtype === 'success') finalText = (message as any).result;
                break;
            }
        }
    } finally {
        abortController.abort();
    }
    return finalText;
}

async function main() {
    initTracing();
    const langfuse = new LangfuseClient();
    const dataset = await langfuse.dataset.get(DATASET_NAME, { fetchItemsPageSize: 100 });
    const activeItems = dataset.items.filter((i) => i.status === 'ACTIVE');
    const ITERATIONS = 2;
    const repeated = activeItems.flatMap((item) => Array.from({ length: ITERATIONS }, () => item));
    console.log(`real-agent run: ${activeItems.length} items x ${ITERATIONS} iterations = ${repeated.length} agent calls`);

    const runName = `spike-iter-probe-real-${Date.now()}`;
    const result = await langfuse.experiment.run({
        name: DATASET_NAME,
        runName,
        description: 'THROWAWAY spike: real agent, 2 items x 2 iterations, no judge.',
        data: repeated,
        task: async (item: any) => {
            const prompt = `In exactly one short sentence, answer: ${item.input.query}. Also append a random 6-digit number.`;
            const answer = await runRealAgent(prompt);
            return { itemId: item.id, answer };
        },
        evaluators: [
            async ({ output }) => ({
                name: 'spike_answer_hash',
                value: 0,
                comment: createHash('sha256').update((output as any).answer).digest('hex').slice(0, 12),
            }),
        ],
        maxConcurrency: 4,
    });

    console.log('runName:', result.runName, 'experimentId:', result.experimentId);
    for (const r of result.itemResults) {
        console.log(' -', (r.item as any).id, '| traceId:', r.traceId, '| answer:', JSON.stringify((r.output as any).answer));
    }

    await langfuse.flush();
    await shutdownTracing();

    const base = process.env.LANGFUSE_BASE_URL;
    const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
    const fromStartTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const toStartTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const expResp = await fetch(`${base}/api/public/experiments?fromStartTime=${fromStartTime}&toStartTime=${toStartTime}&limit=5`, {
        headers: { Authorization: `Basic ${auth}` },
    });
    console.log('\nGET /api/public/experiments ->', await expResp.text());
}

void main();
