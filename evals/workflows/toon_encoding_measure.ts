#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Direct TOON-vs-JSON encoding measurement (no agent, no live calls, deterministic).
 *
 * Isolates exactly what the end-to-end eval cannot: the encoding effect alone. For each real storage
 * payload it builds the same object the storage tools hand to `encodeToon`, emits it both ways (the
 * real wired text: a ```toon fence vs the ```json fence `encodeToon` falls back to when
 * APIFY_MCP_DISABLE_TOON is set), and counts UTF-8 bytes (ground truth) and tokens (o200k_base, the
 * GPT-4o tokenizer — a reproducible proxy; Claude's tokenizer differs but the TOON/JSON ratio is
 * broadly representative).
 *
 * Reads fixtures seeded from real Apify data. Run: pnpm exec tsx evals/workflows/toon_encoding_measure.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { encode as tokenize } from 'gpt-tokenizer/model/gpt-4o';

import { encodeToon } from '../../src/utils/encode_text.js';

const FIXTURES = path.resolve(
    '/private/tmp/claude-501/-Users-robert-Work-apify-mcp-server/1090f5bb-8d61-4032-9244-7a2317296df6/scratchpad/fixtures',
);
const OUT = path.resolve(process.cwd(), 'evals/workflows/toon_encoding_results.json');

/** Emit a value exactly as the storage tools do, for one format, by toggling the server's TOON switch. */
function emit(value: unknown, format: 'toon' | 'json'): string {
    if (format === 'json') process.env.APIFY_MCP_DISABLE_TOON = '1';
    else delete process.env.APIFY_MCP_DISABLE_TOON;
    return encodeToon(value);
}

type Measure = { bytes: number; tokens: number };
function measure(value: unknown): { toon: Measure; json: Measure } {
    const toonText = emit(value, 'toon');
    const jsonText = emit(value, 'json');
    return {
        toon: { bytes: Buffer.byteLength(toonText, 'utf8'), tokens: tokenize(toonText).length },
        json: { bytes: Buffer.byteLength(jsonText, 'utf8'), tokens: tokenize(jsonText).length },
    };
}

const pct = (t: number, j: number) => (j === 0 ? 0 : ((t - j) / j) * 100);
const f = (n: number) => n.toFixed(1);
const readFixture = (name: string): any | null => {
    const p = path.join(FIXTURES, name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

/** Replicate real rows up to n (cycling) so the sweep can exceed the sampled row count. */
function takeRows<T>(rows: T[], n: number): T[] {
    if (rows.length === 0) return [];
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(rows[i % rows.length]);
    return out;
}

type Row = { label: string; rows: number | string; bytesT: number; bytesJ: number; tokT: number; tokJ: number };
const rows: Row[] = [];
const sweeps: Record<
    string,
    { n: number; bytesDeltaPct: number; tokDeltaPct: number; toonTok: number; jsonTok: number }[]
> = {};

function record(label: string, rowCount: number | string, value: unknown): void {
    const m = measure(value);
    rows.push({
        label,
        rows: rowCount,
        bytesT: m.toon.bytes,
        bytesJ: m.json.bytes,
        tokT: m.toon.tokens,
        tokJ: m.json.tokens,
    });
}

// --- Dataset-items payloads (the only uncapped TOON tool) + row-count sweep ---
const SWEEP_N = [1, 5, 10, 25, 50, 100];
for (const [fixture, name] of [
    ['maps_items.json', 'get-dataset-items · compact tabular (Google Maps)'],
    ['rag_items.json', 'get-dataset-items · text-heavy (rag-web-browser)'],
] as const) {
    const fx = readFixture(fixture);
    if (!fx?.items?.length) {
        console.log(`(skip ${name}: fixture missing)`);
        continue;
    }
    sweeps[name] = [];
    for (const n of SWEEP_N) {
        const items = takeRows(fx.items, n);
        const sc = {
            datasetId: fx.datasetId,
            items,
            itemCount: items.length,
            totalItemCount: fx.total ?? items.length,
            offset: 0,
            limit: Math.max(n, 20),
        };
        const m = measure(sc);
        sweeps[name].push({
            n,
            bytesDeltaPct: pct(m.toon.bytes, m.json.bytes),
            tokDeltaPct: pct(m.toon.tokens, m.json.tokens),
            toonTok: m.toon.tokens,
            jsonTok: m.json.tokens,
        });
        if (n === fx.items.length || n === 25) record(name, n, sc);
    }
    // headline row: the real sampled size
    const realItems = fx.items;
    record(name, `${realItems.length} (real)`, {
        datasetId: fx.datasetId,
        items: realItems,
        itemCount: realItems.length,
        totalItemCount: fx.total ?? realItems.length,
        offset: 0,
        limit: 100,
    });
}

// --- Other TOON-routed shapes (capped at 10 rows by schema) ---
const kvs = readFixture('kvs_keys.json');
if (kvs?.items?.length) record('get-key-value-store-keys · {key,size} rows', kvs.items.length, kvs);

const runList = readFixture('run_list.json');
if (runList?.items?.length) record('get-actor-run-list · run rows', runList.items.length, runList);

// --- Report ---
console.log('='.repeat(104));
console.log('DIRECT TOON vs JSON ENCODING MEASUREMENT  (bytes = exact; tokens = o200k_base / GPT-4o proxy)');
console.log('='.repeat(104));
console.log(
    'payload'.padEnd(48) +
        'rows'.padStart(10) +
        'toonTok'.padStart(9) +
        'jsonTok'.padStart(9) +
        'Δtok'.padStart(8) +
        'Δbytes'.padStart(8),
);
for (const r of rows) {
    console.log(
        r.label.padEnd(48) +
            String(r.rows).padStart(10) +
            String(r.tokT).padStart(9) +
            String(r.tokJ).padStart(9) +
            `${f(pct(r.tokT, r.tokJ))}%`.padStart(8) +
            `${f(pct(r.bytesT, r.bytesJ))}%`.padStart(8),
    );
}
console.log('\nROW-COUNT SWEEP (token Δ%, TOON vs JSON):');
for (const [name, pts] of Object.entries(sweeps)) {
    console.log(`  ${name}`);
    console.log('    ' + pts.map((p) => `n=${p.n}:${f(p.tokDeltaPct)}%`).join('  '));
}

fs.writeFileSync(OUT, JSON.stringify({ rows, sweeps, tokenizer: 'o200k_base (gpt-4o)' }, null, 2));
console.log(`\n📄 ${OUT}`);
