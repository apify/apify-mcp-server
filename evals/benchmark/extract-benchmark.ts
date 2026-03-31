/**
 * Benchmark token extractor
 *
 * Reads a Claude Code session JSONL file, filters assistant turns by each run's
 * timestamp window, and populates token/cost/context fields in results/runs.jsonl.
 *
 * Usage:
 *   npx tsx evals/benchmark/extract-benchmark.ts <path-to-session.jsonl>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Usage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

interface SessionEntry {
    type: string;
    timestamp: string;
    message: { usage: Usage };
}

// ---------------------------------------------------------------------------
// Model pricing (USD per million tokens)
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
    'claude-sonnet-4-6':         { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
    'claude-opus-4-6':           { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
    'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00,  cacheWrite: 1.00,  cacheRead: 0.08 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deduplicate usage objects by value (Claude Code emits identical objects for streamed chunks). */
function dedup(usages: Usage[]): Usage[] {
    const seen = new Set<string>();
    return usages.filter((u) => {
        const key = JSON.stringify(u);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Total input tokens for one API call = uncached + cache_creation + cache_read. */
function totalInput(u: Usage): number {
    return u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

function sumUsages(usages: Usage[]) {
    const d = dedup(usages);
    const input_tokens          = d.reduce((s, u) => s + u.input_tokens, 0);
    const output_tokens         = d.reduce((s, u) => s + u.output_tokens, 0);
    const cache_creation_tokens = d.reduce((s, u) => s + (u.cache_creation_input_tokens ?? 0), 0);
    const cache_read_tokens     = d.reduce((s, u) => s + (u.cache_read_input_tokens ?? 0), 0);
    return { input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        total_tokens: input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens };
}

function computeCost(sums: ReturnType<typeof sumUsages>, model: string): number {
    const p = PRICING[model] ?? PRICING['claude-sonnet-4-6'];
    return (
        sums.input_tokens * p.input / 1e6
        + sums.output_tokens * p.output / 1e6
        + sums.cache_creation_tokens * p.cacheWrite / 1e6
        + sums.cache_read_tokens * p.cacheRead / 1e6
    );
}

function readJsonl<T>(path: string): T[] {
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}

function writeJsonl(path: string, records: object[]): void {
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sessionJsonlPath = process.argv[2];
if (!sessionJsonlPath) {
    console.error('Usage: npx tsx evals/benchmark/extract-benchmark.ts <path-to-session.jsonl>');
    process.exit(1);
}

const sessionId = basename(sessionJsonlPath, '.jsonl');
const runsPath = resolve(fileURLToPath(import.meta.url), '..', 'runs.jsonl');

const entries: SessionEntry[] = readFileSync(sessionJsonlPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SessionEntry)
    .filter((e) => e.type === 'assistant' && e.message?.usage != null);

const runs = readJsonl<Record<string, unknown>>(runsPath);
let updated = 0;

for (const run of runs) {
    if (run.session_id !== sessionId) continue;
    if (!run.started_at || !run.ended_at) continue; // skip _baseline rows

    const window = entries.filter(
        (e) => e.timestamp >= (run.started_at as string) && e.timestamp <= (run.ended_at as string),
    );
    const usages = window.map((e) => e.message.usage);
    const sums = sumUsages(usages);

    const deduped = dedup(usages);
    const ctxStart = deduped.length > 0 ? totalInput(deduped[0]) : null;
    const ctxEnd   = deduped.length > 0 ? totalInput(deduped[deduped.length - 1]) : null;

    Object.assign(run, {
        ...sums,
        cost_usd: parseFloat(computeCost(sums, run.model as string).toFixed(6)),
        ctx_start_tokens: ctxStart,
        ctx_end_tokens: ctxEnd,
        ctx_delta_tokens: ctxStart != null && ctxEnd != null ? ctxEnd - ctxStart : null,
    });
    updated++;
}

writeJsonl(runsPath, runs);

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------

const matchedRuns = runs.filter((r) => r.session_id === sessionId);
if (matchedRuns.length === 0) {
    console.error(`No runs found for session ${sessionId}`);
    process.exit(1);
}

console.log(`\n${matchedRuns[0].condition} (${matchedRuns[0].model}) — ${updated} runs updated\n`);

const cols = [
    { key: 'scenario_id',           label: 'scenario',    w: 30, align: 'l' as const },
    { key: 'ctx_start_tokens',      label: 'ctx_start',   w: 10, align: 'r' as const },
    { key: 'ctx_delta_tokens',      label: 'ctx_Δ',       w: 8,  align: 'r' as const, fmt: (v: unknown) => v != null ? `+${v}` : '-' },
    { key: 'input_tokens',          label: 'input',       w: 8,  align: 'r' as const },
    { key: 'output_tokens',         label: 'output',      w: 8,  align: 'r' as const },
    { key: 'cache_creation_tokens', label: 'cache_write', w: 12, align: 'r' as const },
    { key: 'cache_read_tokens',     label: 'cache_read',  w: 12, align: 'r' as const },
    { key: 'total_tokens',          label: 'total',       w: 10, align: 'r' as const },
    { key: 'cost_usd',              label: 'cost',        w: 9,  align: 'r' as const, fmt: (v: unknown) => v != null ? `$${v}` : '-' },
    { key: 'duration_s',            label: 'dur',         w: 6,  align: 'r' as const, fmt: (v: unknown) => v != null ? `${v}s` : '-' },
];

const header = cols.map((c) => c.align === 'l' ? c.label.padEnd(c.w) : c.label.padStart(c.w)).join('  ');
console.log(header);
console.log('-'.repeat(header.length));

for (const run of matchedRuns) {
    const line = cols.map((c) => {
        const raw = run[c.key];
        const val = c.fmt ? c.fmt(raw) : String(raw ?? '-');
        return c.align === 'l' ? val.padEnd(c.w) : val.padStart(c.w);
    }).join('  ');
    console.log(line);
}
