/**
 * Manpage-style guide for writing Code Mode scripts (the `run-code` tool). Each page is a single
 * focused unit; `get-code-docs` serves one page at a time. Keep pages reasonably sized — exhaustive
 * per-method detail lives in the linked actor-code-runtime API reference.
 */

import { HelperTools } from '../../const.js';

/** Ordered page names; `overview` is the default/index page. */
export const CODE_DOCS_PAGE_NAMES = ['overview', 'api', 'recipes'] as const;

export type CodeDocsPage = (typeof CODE_DOCS_PAGE_NAMES)[number];

/** Identical navigation footer appended to every page; the page list comes from the single source. */
const SEE_ALSO = `## SEE ALSO
Other Code Mode guide pages (call ${HelperTools.CODE_DOCS} with page=<name>): ${CODE_DOCS_PAGE_NAMES.join(', ')}.`;

const OVERVIEW = `# Code Mode — runtime & result contract

\`${HelperTools.CODE_RUN}\` executes one async JavaScript/TypeScript script in a sandboxed Apify Actor. Use it to do
many operations in a single run — search, run and chain Actors, read datasets, then
filter/aggregate locally — instead of sending every intermediate result back through the model.

## Execution
- Your code is an async script body with top-level \`await\`.
- Two globals are injected: \`apify\` (the Apify binding) and \`console\`.
- Sandbox: no filesystem, no package imports (no \`require\`/\`import\`), outbound \`fetch\` limited to the
  apify.com domain and its subdomains (\`*.apify.com\`) only, limited permissions, single-use container
  (nothing persists between runs).

## Before using an Actor
For every Actor you plan to run from your script, FIRST call the \`${HelperTools.ACTOR_GET_DETAILS}\` tool to read
its input and output schemas. Use it to build valid \`input\` and to know which output fields the run
produces, so your code reads the right ones. (In-script, \`apify.actor.getDetails({ actorId })\`
returns the same Actor record at runtime.)

## Returning results
- \`console.log\` / \`console.info\` go to stdout; \`console.error\` / \`console.warn\` go to stderr.
- When the script finishes, both are stored in the run's default dataset as a single item
  \`{ stdout, stderr }\`, which the caller reads with ${HelperTools.DATASET_GET_ITEMS}.
- Your answer = what you print. Print a concise, JSON-stringified summary of the distilled result —
  never dump entire datasets (that wastes tokens and context).
- If your script throws, the error is captured to stderr and the run still SUCCEEDS, so failures are
  observable in the output.
- For long scripts, the run may still be RUNNING when \`${HelperTools.CODE_RUN}\`'s wait cap (waitSecs)
  elapses — the caller then polls ${HelperTools.ACTOR_RUNS_GET} until it finishes.

## Save storage IDs before you process
Actor runs cost money and the post-run processing is what usually breaks. As each run finishes,
\`console.log\` its \`run.id\` / \`defaultDatasetId\` / \`defaultKeyValueStoreId\` BEFORE processing — if the
script then throws, re-run reading those existing storages instead of paying to run the Actors again.

${SEE_ALSO}`;

const API = `# The \`apify\` binding

A global \`apify\` object exposes a typed subset of the Apify API, authenticated with the run's token.
Every method is async, takes one options object, and returns parsed JSON.

## Actors
apify.actor.search({ query, limit?, category? })            // → actors[]
apify.actor.getDetails({ actorId })                         // → actor (incl. input schema)
apify.actor.start({ actorId, input?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })  // → run (async)
apify.actor.run({ actorId, input?, waitForFinishSecs = 60, ...startOpts })   // → run (waits, cap 60s)
apify.actor.runAndGetItems({ actorId, input?, fields?, limit?, ...runOpts })  // → { run, items }

## Runs
apify.run.get({ runId })                                    // → run
apify.run.wait({ runId, waitForFinishSecs = 60 })           // → run
apify.run.abort({ runId })                                  // → run
apify.run.getLog({ runId, limit? })                         // → string

## Datasets
apify.dataset.create({ name? })                             // → dataset
apify.dataset.pushItems({ datasetId, items })               // → void
apify.dataset.listItems({ datasetId, fields?, omit?, limit?, offset?, clean?, desc? })  // → items[]
apify.dataset.iterate({ datasetId, batchSize = 1000, ...filters })  // → async iterable
apify.dataset.getSchema({ datasetId, sample = 5 })          // → { itemCount, sampleSize, fields[] }

## Key-value stores
apify.kvs.create({ name? })                                 // → store
apify.kvs.set({ storeId, key, value, contentType? })        // → void
apify.kvs.get({ storeId, key })                             // → value | null (null when missing)
apify.kvs.list({ storeId, limit?, exclusiveStartKey? })     // → { items: [{ key, size }] }

Full per-method reference: https://github.com/apify/actor-code-runtime/blob/master/docs/API.md

${SEE_ALSO}`;

const RECIPES = `# Recipes — calling Actors & working with storages

## Discover and inspect
const found = await apify.actor.search({ query: 'instagram', limit: 5 });
const details = await apify.actor.getDetails({ actorId: 'apify/instagram-scraper' });
// details includes the input schema — build a valid \`input\` from it.

## Run: sync vs async
- apify.actor.run({ actorId, input, waitForFinishSecs }) starts and waits (cap 60s/call) → run.
- apify.actor.start({ actorId, input }) returns immediately (status READY/RUNNING).
- apify.actor.runAndGetItems({ actorId, input, limit }) runs then returns { run, items }.
- Each run is billed — bound cost with the Actor's own input limits and callOptions (maxItems for
  pay-per-result, maxTotalChargeUsd for pay-per-event).

## Runs longer than 60s: start, then poll until terminal
let run = await apify.actor.start({ actorId, input });
const TERMINAL = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];
while (!TERMINAL.includes(run.status)) {
    run = await apify.run.wait({ runId: run.id, waitForFinishSecs: 60 });
}

## Chain Actors (one run's output → next run's input)
const { items } = await apify.actor.runAndGetItems({
    actorId: 'apify/google-search-scraper', input: { queries: 'apify' }, limit: 10,
});
const startUrls = items.flatMap((i) => i.organicResults ?? []).map((r) => ({ url: r.url }));
const { items: pages } = await apify.actor.runAndGetItems({
    actorId: 'apify/website-content-crawler', input: { startUrls },
});

## Run many inputs, keep going on errors
const inputs = [{ query: 'a' }, { query: 'b' }, { query: 'c' }];
const collected = [];
for (const input of inputs) {
    try {
        const { items } = await apify.actor.runAndGetItems({ actorId: 'apify/rag-web-browser', input, limit: 5 });
        collected.push(...items);
    } catch (err) {
        console.error('failed input ' + JSON.stringify(input) + ': ' + err.message);
    }
}

## Datasets
- Read one page: const items = await apify.dataset.listItems({ datasetId, limit: 50, fields: ['title', 'url'] });
- Iterate everything (auto-pages): for await (const item of apify.dataset.iterate({ datasetId })) { /* ... */ }
- Write your own results: const ds = await apify.dataset.create(); await apify.dataset.pushItems({ datasetId: ds.id, items: [{ a: 1 }] });
- Inspect shape/count: const schema = await apify.dataset.getSchema({ datasetId });
A run's results live in run.defaultDatasetId; use \`fields\` and \`limit\` to keep payloads small.

## Key-value stores (non-tabular blobs, intermediate state)
const kv = await apify.kvs.create();
await apify.kvs.set({ storeId: kv.id, key: 'state', value: { seen: [] } }); // object → JSON
const state = await apify.kvs.get({ storeId: kv.id, key: 'state' });        // → object, or null if missing
\`kvs.get\` returns null (not an error) for a missing key, so lookup-or-default needs no try/catch.
Read type follows the stored content type: JSON → object, text/* → string, else Uint8Array.

## Aggregate locally, return little
Do the data-wrangling in JS and print only the distilled result:
const { items } = await apify.actor.runAndGetItems({
    actorId: 'apify/google-search-scraper', input: { queries: 'web scraping' }, limit: 50,
});
const top = items
    .flatMap((i) => i.organicResults ?? [])
    .slice(0, 5)
    .map((r) => ({ title: r.title, url: r.url }));
console.log(JSON.stringify(top)); // 5 rows back to the model, not 50 pages of raw output

${SEE_ALSO}`;

export const CODE_DOCS_PAGES: Record<CodeDocsPage, string> = {
    overview: OVERVIEW,
    api: API,
    recipes: RECIPES,
};
