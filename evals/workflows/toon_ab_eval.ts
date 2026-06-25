#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * TOON vs JSON A/B harness.
 *
 * Runs the full workflow suite N times per format (default 5) and averages bytes, tokens, and
 * accuracy so TOON's savings and any accuracy regression can be read off one report. Formats are
 * interleaved per run (toon, json, toon, json, …) so both see similar live-Actor conditions.
 *
 * The format is toggled with APIFY_MCP_DISABLE_TOON, which the MCP subprocess inherits at spawn
 * (see src/utils/encode_text.ts). A fresh McpClient is spawned per test, so flipping the parent env
 * between sequential format batches is safe.
 *
 * Usage:
 *   pnpm run build && tsx evals/workflows/toon_ab_eval.ts            # 5 runs/format, concurrency 6
 *   tsx evals/workflows/toon_ab_eval.ts --runs 3 --concurrency 8
 */

import fs from 'node:fs';
import path from 'node:path';

import pLimit from 'p-limit';

import { MODELS, sanitizeEnvValue } from './config.js';
import { executeConversation } from './conversation_executor.js';
import { LlmClient } from './llm_client.js';
import { McpClient } from './mcp_client.js';
import { sumResultBytes } from './output_formatter.js';
import type { WorkflowTestCase } from './test_cases_loader.js';
import { loadTestCases } from './test_cases_loader.js';
import { evaluateConversation } from './workflow_judge.js';

type Format = 'toon' | 'json';

/** One test outcome within a single run of one format. */
type TestOutcome = {
    testId: string;
    category: string;
    verdict: 'PASS' | 'FAIL';
    error: string | null;
    resultBytes: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    turns: number;
    durationMs: number;
};

/** Aggregate of one full suite run of one format. */
type RunTotals = {
    format: Format;
    run: number;
    passCount: number;
    failCount: number;
    errorCount: number;
    totalBytes: number;
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    durationMs: number;
    outcomes: TestOutcome[];
};

const TOOL_TIMEOUT_SECONDS = 60;

function parseArgs(): { runs: number; concurrency: number; limit: number; category: string; ids: string[] } {
    const argv = process.argv.slice(2);
    let runs = 5;
    let concurrency = 6;
    let limit = 0; // 0 = all test cases
    let category = ''; // '' = all categories
    let ids: string[] = []; // [] = all ids
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--runs') runs = Number(argv[++i]);
        else if (argv[i] === '--concurrency') concurrency = Number(argv[++i]);
        else if (argv[i] === '--limit') limit = Number(argv[++i]);
        else if (argv[i] === '--category') category = argv[++i];
        else if (argv[i] === '--ids')
            ids = argv[++i]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
    }
    return { runs, concurrency, limit, category, ids };
}

/** Toggle the MCP server output format via env (read by the subprocess on spawn). */
function setFormat(format: Format): void {
    if (format === 'json') process.env.APIFY_MCP_DISABLE_TOON = '1';
    else delete process.env.APIFY_MCP_DISABLE_TOON;
}

/** Run one test case end-to-end and reduce it to a TestOutcome. Never throws. */
async function runOneTest(testCase: WorkflowTestCase, llmClient: LlmClient, apifyToken: string): Promise<TestOutcome> {
    const mcpClient = new McpClient(TOOL_TIMEOUT_SECONDS);
    const start = Date.now();
    try {
        await mcpClient.start(apifyToken, testCase.tools);
        const conversation = await executeConversation({
            userPrompt: testCase.query,
            mcpClient,
            llmClient,
            maxTurns: testCase.maxTurns,
            model: MODELS.agent,
            serverInstructions: mcpClient.getInstructions(),
        });
        const judge = await evaluateConversation(testCase, conversation, llmClient, MODELS.judge);
        return {
            testId: testCase.id,
            category: testCase.category,
            verdict: judge.verdict,
            error: null,
            resultBytes: sumResultBytes(conversation),
            promptTokens: conversation.promptTokens ?? 0,
            completionTokens: conversation.completionTokens ?? 0,
            totalTokens: conversation.totalTokens ?? 0,
            turns: conversation.totalTurns,
            durationMs: Date.now() - start,
        };
    } catch (error) {
        return {
            testId: testCase.id,
            category: testCase.category,
            verdict: 'FAIL',
            error: error instanceof Error ? error.message : String(error),
            resultBytes: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            turns: 0,
            durationMs: Date.now() - start,
        };
    } finally {
        try {
            await mcpClient.cleanup();
        } catch {
            // ignore cleanup failures
        }
    }
}

/** Run the full suite once for one format, with bounded concurrency. */
async function runSuite(
    format: Format,
    run: number,
    testCases: WorkflowTestCase[],
    llmClient: LlmClient,
    apifyToken: string,
    concurrency: number,
): Promise<RunTotals> {
    setFormat(format);
    const tag = `run ${run} · ${format.toUpperCase()}`;
    console.log(`\n▶️  ${tag}: ${testCases.length} tests (concurrency ${concurrency})`);
    const start = Date.now();

    const limit = pLimit(concurrency);
    let done = 0;
    const outcomes = await Promise.all(
        testCases.map(async (tc) =>
            limit(async () => {
                const outcome = await runOneTest(tc, llmClient, apifyToken);
                done++;
                const mark = outcome.error ? '🔥' : outcome.verdict === 'PASS' ? '✅' : '❌';
                console.log(
                    `   [${tag}] ${mark} ${done}/${testCases.length} ${outcome.testId} ` +
                        `(${outcome.resultBytes} B, ${outcome.totalTokens} tok)`,
                );
                return outcome;
            }),
        ),
    );

    const totals: RunTotals = {
        format,
        run,
        passCount: outcomes.filter((o) => !o.error && o.verdict === 'PASS').length,
        failCount: outcomes.filter((o) => !o.error && o.verdict === 'FAIL').length,
        errorCount: outcomes.filter((o) => o.error).length,
        totalBytes: outcomes.reduce((s, o) => s + o.resultBytes, 0),
        totalTokens: outcomes.reduce((s, o) => s + o.totalTokens, 0),
        totalPromptTokens: outcomes.reduce((s, o) => s + o.promptTokens, 0),
        totalCompletionTokens: outcomes.reduce((s, o) => s + o.completionTokens, 0),
        durationMs: Date.now() - start,
        outcomes,
    };
    console.log(
        `   ${tag} done: ${totals.passCount}/${outcomes.length} pass · ` +
            `${totals.totalBytes} B · ${totals.totalTokens} tok · ${(totals.durationMs / 1000).toFixed(0)}s`,
    );
    return totals;
}

const avg = (nums: number[]): number => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);

async function main(): Promise<void> {
    const { runs, concurrency, limit, category, ids } = parseArgs();

    const apifyToken = sanitizeEnvValue(process.env.APIFY_TOKEN);
    const openrouterKey = sanitizeEnvValue(process.env.OPENROUTER_API_KEY);
    if (!apifyToken) throw new Error('APIFY_TOKEN is required');
    if (!openrouterKey) throw new Error('OPENROUTER_API_KEY is required');

    const stdioBin = path.resolve(process.cwd(), 'dist/stdio.js');
    if (!fs.existsSync(stdioBin)) throw new Error('dist/stdio.js missing — run `pnpm run build` first');

    // Filters compose: --ids (explicit allow-list) → --category → --limit (head slice).
    let testCases = loadTestCases();
    if (ids.length > 0) testCases = testCases.filter((tc) => ids.includes(tc.id));
    if (category) testCases = testCases.filter((tc) => tc.category === category);
    if (limit > 0) testCases = testCases.slice(0, limit);
    if (testCases.length === 0) throw new Error('No test cases matched the --ids/--category/--limit filters');
    const llmClient = new LlmClient();

    console.log('='.repeat(100));
    console.log(`TOON vs JSON A/B — ${runs} runs/format · ${testCases.length} tests · agent ${MODELS.agent}`);
    console.log('='.repeat(100));

    const allRuns: RunTotals[] = [];
    for (let run = 1; run <= runs; run++) {
        // Interleave formats within each run so both face similar live-Actor conditions.
        allRuns.push(await runSuite('toon', run, testCases, llmClient, apifyToken, concurrency));
        allRuns.push(await runSuite('json', run, testCases, llmClient, apifyToken, concurrency));
    }

    const byFormat = (f: Format) => allRuns.filter((r) => r.format === f);
    const summarize = (f: Format) => {
        const rs = byFormat(f);
        return {
            format: f,
            runs: rs.length,
            avgPassCount: avg(rs.map((r) => r.passCount)),
            avgPassRate: avg(rs.map((r) => r.passCount / testCases.length)),
            avgBytes: avg(rs.map((r) => r.totalBytes)),
            avgTokens: avg(rs.map((r) => r.totalTokens)),
            avgPromptTokens: avg(rs.map((r) => r.totalPromptTokens)),
            avgCompletionTokens: avg(rs.map((r) => r.totalCompletionTokens)),
            avgDurationMs: avg(rs.map((r) => r.durationMs)),
            perRunPassCount: rs.map((r) => r.passCount),
            perRunBytes: rs.map((r) => r.totalBytes),
            perRunTokens: rs.map((r) => r.totalTokens),
        };
    };

    // Per-test averages across runs (for breakdown + spotting accuracy regressions).
    const perTest = testCases.map((tc) => {
        const pick = (f: Format) =>
            allRuns.filter((r) => r.format === f).map((r) => r.outcomes.find((o) => o.testId === tc.id)!);
        const toon = pick('toon');
        const json = pick('json');
        return {
            testId: tc.id,
            category: tc.category,
            toon: {
                passRate: avg(toon.map((o) => (o.verdict === 'PASS' && !o.error ? 1 : 0))),
                avgBytes: avg(toon.map((o) => o.resultBytes)),
                avgTokens: avg(toon.map((o) => o.totalTokens)),
            },
            json: {
                passRate: avg(json.map((o) => (o.verdict === 'PASS' && !o.error ? 1 : 0))),
                avgBytes: avg(json.map((o) => o.resultBytes)),
                avgTokens: avg(json.map((o) => o.totalTokens)),
            },
        };
    });

    const toon = summarize('toon');
    const json = summarize('json');
    const pct = (cur: number, base: number) => (base === 0 ? 0 : ((cur - base) / base) * 100);

    const report = {
        meta: {
            runsPerFormat: runs,
            testCount: testCases.length,
            concurrency,
            agentModel: MODELS.agent,
            judgeModel: MODELS.judge,
            note: 'Bytes = UTF-8 tool-result bytes fed to the agent. Tokens = agent prompt+completion (judge excluded). Live-Actor output varies between calls, hence averaging.',
        },
        summary: { toon, json },
        comparison: {
            bytes: { toonAvg: toon.avgBytes, jsonAvg: json.avgBytes, deltaPct: pct(toon.avgBytes, json.avgBytes) },
            tokens: { toonAvg: toon.avgTokens, jsonAvg: json.avgTokens, deltaPct: pct(toon.avgTokens, json.avgTokens) },
            accuracy: {
                toonPassRate: toon.avgPassRate,
                jsonPassRate: json.avgPassRate,
                deltaPoints: (toon.avgPassRate - json.avgPassRate) * 100,
            },
        },
        perTest,
        rawRuns: allRuns,
    };

    const outDir = path.resolve(process.cwd(), 'evals/workflows');
    const outPath = path.join(outDir, 'toon_ab_results.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log(`\n${'='.repeat(100)}`);
    console.log('AVERAGED RESULTS (TOON vs JSON)');
    console.log('='.repeat(100));
    console.log(
        `Bytes/run   TOON ${Math.round(toon.avgBytes)}  vs  JSON ${Math.round(json.avgBytes)}  → ${pct(toon.avgBytes, json.avgBytes).toFixed(1)}%`,
    );
    console.log(
        `Tokens/run  TOON ${Math.round(toon.avgTokens)}  vs  JSON ${Math.round(json.avgTokens)}  → ${pct(toon.avgTokens, json.avgTokens).toFixed(1)}%`,
    );
    console.log(
        `Pass rate   TOON ${(toon.avgPassRate * 100).toFixed(1)}%  vs  JSON ${(json.avgPassRate * 100).toFixed(1)}%  → ${((toon.avgPassRate - json.avgPassRate) * 100).toFixed(1)} pts`,
    );
    console.log(`\n📄 Full report: ${outPath}`);
}

void main().catch((err) => {
    console.error(err);
    process.exit(1);
});
