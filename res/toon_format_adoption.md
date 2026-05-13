# TOON format adoption

## Problem

MCP tool results land in the LLM context window. Most tools wire
JSON-encoded payloads (Actor runs, dataset listings, KV-store keys,
dataset items). JSON repeats every object key on every row of an
array. Context costs tokens and dilutes model attention, and once a
tool result lands it stays in the conversation for every subsequent
turn — the savings compound per request.

## TL;DR

Switching the text content of certain MCP tool responses from JSON to
[TOON](https://toonformat.dev/) (a more compact LLM-oriented format,
introduced below) measurably reduces context bytes — and stacks
massively with field projection on realistic agentic workloads.

| Tool                              | Δ vs current JSON | Strategy that wins most often  |
|-----------------------------------|------------------:|--------------------------------|
| `get-actor-run-list`              |            −44.0% | `toon-flatten`                 |
| `get-dataset-list`                |            −31.6% | `toon-flatten` (mixed-schema: `json`) |
| `get-key-value-store-list`        |            −31.3% | `toon-flatten` (mixed-schema: `json`) |
| `get-key-value-store-keys`        |            −19.0% | `toon-flatten`                 |
| `dataset-items`                   |             −1.2% | depends on the Actor           |
| **Combined across 18 fixtures**   |          **−6.2%** | `toon-flatten` 10/18, `json` 8/18 |

**Combined with field projection** (`fields=name,url,rating` on a
100-place Google-Maps result — see [Field projection benchmark](#field-projection-benchmark)
below): **1.01 MB → 9.5 KB**, ~110× smaller payload entering the LLM
context.

Two guarantees make adoption safe:

- **Never worse than today.** The mechanism is an *adaptive picker*
  that encodes both JSON and TOON per call and ships whichever is
  smaller. JSON is always a candidate.
- **`structuredContent` is unchanged.** Only `TextContent.text` shifts.
  `outputSchema` validation, MCP widgets, and programmatic consumers
  continue to see the original JSON view.

The rest of this document covers what TOON is, the measurement
methodology, the picker's implementation and edge cases, and
trade-offs.

## What TOON is

[TOON](https://toonformat.dev/) (Token-Oriented Object Notation) encodes
the JSON data model with one trick JSON lacks: **tabular form** for
arrays of similarly-shaped objects. Keys go in a header line; each row
is one comma-separated record:

```
items[5]{id,status,startedAt,usageTotalUsd}:
  toaYdmG…,SUCCEEDED,"2026-05-12T09:18:27.527Z",0.00008311
  CkbooBH…,SUCCEEDED,"2026-05-12T09:17:57.206Z",0.00392022
  …
```

JSON re-emits those four keys on every row. Dropping that repetition
(plus the per-row `{}` and `:` punctuation) is where TOON's savings
come from.

Tabular form requires every array element to be a scalar-only object
with the same keys. Nested objects, missing optionals, or inline arrays
force a list-of-objects fallback that costs **more** bytes than JSON
(indent overhead exceeds brace+quote overhead). Payload shape, not tool
identity, determines whether TOON helps.

## What we evaluated

18 live Apify API fixtures across five tool groups:

- `get-actor-run-list` (2)
- `get-dataset-list` (2 real + 1 synthetic)
- `get-key-value-store-list` (2 real + 1 synthetic)
- `get-key-value-store-keys` (2)
- `get-dataset-items` from 4 Actors: `apify/rag-web-browser`,
  `compass/crawler-google-places`, `apify/instagram-scraper`,
  `apify/instagram-post-scraper` (8 total)

Sizes are measured in **UTF-8 bytes**, not LLM tokens. Tokens are
tokenizer-specific and not reproducible across models; bytes are. We
expect token savings to track byte savings on the kind of payloads in
scope here, but the proposal's headline numbers are bytes only.

Every encoding round-trips to a JSON-equal value; mismatches fail the
run.

> **Synthetic mixed-schema fixtures.** Dataset and KV-store list
> responses include an optional `schema` field (user-defined nested
> JSON Schema), present only on storages that declare one. The test
> account had zero such storages — auto-generated storages don't carry
> a schema — so real fixtures couldn't exercise heterogeneous-schema
> rows. We generated additional fixtures with `schema` populated on
> half the rows using realistic dataset/KV-store schema shapes to
> verify the picker falls back to `json` correctly.

---

## Field projection benchmark

The picker's wins compound with a `fields=` projection parameter on the
tools that return rich items. Realistic agentic scenario: the agent
asks a Google-Maps-style scraper for 100 places but only needs
`name`, `url`, `rating` to summarise.

| Encoding (100 places, ~60 fields each) | Bytes | vs current |
|---|---:|---:|
| Full JSON (current behaviour) | 1.01 MB | baseline |
| Full TOON-flatten | 893 KB | −14.0% |
| Projected JSON (`fields=name,url,rating`) | 12.3 KB | −98.8% |
| **Projected + picker (`fields=` + TOON)** | **9.5 KB** | **−99.1%** |

Projection alone is the dominant lever (−98.8%); the picker adds
another −23% relative to the projected JSON baseline because the
projected payload is exactly TOON's sweet spot (uniform 3-scalar-field
rows). Combined: **~110× smaller payload entering the LLM context**.

`fields=` is out of scope for this document and tracked separately.

## Scope

In scope: tools whose text content today is a JSON encoding of
structured data — `get-actor-run-list`, `get-dataset-list`,
`get-key-value-store-list`, `get-key-value-store-keys`,
`get-dataset-items`, `get-actor-output`, `get-dataset`,
`get-key-value-store`, etc.

Out of scope:

- Tools that already ship non-JSON text content (Markdown cards, plain
  log output, etc.) — adopting TOON there would change the rendered
  shape, not just the encoding. Separate decision.

## The picker

At every in-scope tool-call site, the picker encodes both candidates and
ships the smaller. JSON is always present; any other candidate is
wrapped in `try`/`catch` and dropped on failure — JSON is the
guaranteed fallback, so no tool call ever fails because of the picker.

| Candidate       | What it does                                                                            |
|-----------------|-----------------------------------------------------------------------------------------|
| `json`          | Current behaviour — `JSON.stringify` of the structured payload                          |
| `toon-flatten`  | `encode(dotFlatten(payload))` — unlocks TOON tabular form for uniform-key nested objects |

```ts
const json = JSON.stringify(payload);
const candidates: { name: string; text: string }[] = [{ name: 'json', text: json }];

try {
  candidates.push({ name: 'toon-flatten', text: encodeToon(dotFlatten(payload)) });
} catch {
  // Any failure in dotFlatten or encodeToon — silently drop the candidate.
  // The picker still ships JSON; no tool call ever fails because of this.
}

const best = candidates.reduce((a, b) =>
  Buffer.byteLength(b.text, 'utf8') < Buffer.byteLength(a.text, 'utf8') ? b : a);

return {
  content: [{ type: 'text', text: best.text }],
  structuredContent: payload,                       // unchanged
  _meta: { 'com.apify/encodingStrategy': best.name }, // per-tool win-rate telemetry
};
```

## The `flatten` transform

Nested objects defeat TOON's tabular form. Dot-flatten lifts the nested
keys into the top-level row, restoring the tabular precondition.

### Semantics

```
MAX_DEPTH = 20

flatten(value, depth = 0):
  if depth > MAX_DEPTH:           throw new RangeError('flatten: max depth exceeded')
  if value is an array:           return value.map(v => flatten(v, depth + 1))
  if value is a non-null object:  return flattenObject(value, '', depth)
  otherwise (scalar / null):      return value                     // unchanged

flattenObject(obj, prefix, depth):
  out = {}
  for (k, v) in obj:
    safeKey = k.replace('.', '_')                                   // see Edge cases
    key = prefix ? prefix + '.' + safeKey : safeKey
    if v is a non-null, non-array object:
      merge flattenObject(v, key, depth + 1) into out               // recurse, dot-prefix
    else:
      if key already in out: throw RangeError                       // collision guard
      out[key] = flatten(v, depth + 1)                              // scalars unchanged; arrays recursed into
  return out
```

Key behaviours:
- Arrays at any level are recursed into; each array stays an array,
  its object elements are flattened individually. This is what lets
  TOON emit a tabular header for a list response.
- Inline arrays of scalars (`tags: ['a','b']`) are kept as-is on the
  flattened key; TOON encodes them inline.
- Arrays of objects nested under an object key (`pricingInfos: […]`)
  are kept under that key; their elements are flattened but the array
  is preserved — TOON falls back to indented form for that sub-array.
- Scalars (string / number / boolean / null) are returned unchanged.

### Edge cases and protection

- **Bounded recursion.** The `MAX_DEPTH` guard prevents runaway
  recursion on pathological inputs — throws `RangeError`, the picker's
  `try`/`catch` drops the `toon-flatten` candidate, and `json` ships.
  `20` is comfortable: the deepest real fixture measured is depth 9
  (a user-declared dataset schema), giving a margin of 11.
- **Keys containing literal `.`** — source keys with literal dots
  would collide with the nesting separator. Resolved by normalising
  `.` → `_` in source keys before flatten. The mapping is one-way
  LLM-readable; `structuredContent` (untouched) preserves the
  original keys for programmatic consumers.
- **Normalisation collisions** — if normalisation would produce a
  collision (e.g. a payload with both `'a.b'` and `'a_b'` as keys at
  the same level), flatten throws `RangeError`, the picker drops the
  `toon-flatten` candidate, and `json` ships. No silent data loss is
  possible. Apify API responses don't use such keys today, but the
  guard makes flatten safe if that ever changes.

### Example

Input rows with a uniform nested shape:

```js
[
  { id: 1, stats: { runs: 10, reads: 5 } },
  { id: 2, stats: { runs: 20, reads: 8 } },
  { id: 3, stats: { runs: 30, reads: 12 } },
]
```

Dot-flatten produces two dotted columns; TOON declares them once in the
tabular header:

```
items[3]{id,stats.runs,stats.reads}:
  1,10,5
  2,20,8
  3,30,12
```

### When it wins, when it doesn't

Flatten wins when rows share the same nested key set (Actor runs,
storage list items, uniform-schema dataset items).

It does not help in two distinct cases:

- **Nested shapes vary per row** — e.g. `schema`-bearing dataset/KV-store
  mixes. Flatten explodes the column count, the JSON candidate beats
  it, and the picker falls back to `json`.
- **Prose-dominated payloads** — e.g. `apify/rag-web-browser`,
  Instagram captions. Flatten works fine but the savings are
  negligible: key overhead is a tiny fraction of total bytes when the
  rows are mostly prose.

Lossless: the consumer recovers the original structure by un-flattening
dotted keys. Round-trip verified on all 18 fixtures.

> **An alternative transform we tested and dropped.** We also evaluated
> a `stringify` transform that collapses each row's non-scalar fields
> to a JSON string — the dual of flatten. It never won the picker on
> any in-scope fixture, so a third candidate would have grown the
> implementation without affecting the output.

## Why adaptive over a static per-tool choice

`dataset-items` returns whatever shape the chosen Actor produced — the
MCP server has no idea ahead of time whether the rows will be uniform
structured data or unstructured prose. Four sampled Actors show the
picker splitting between `toon-flatten` and `json` based purely on
payload shape:

| Actor                              | Adaptive picks   | Why                                                       |
|------------------------------------|------------------|------------------------------------------------------------|
| `compass/crawler-google-places`    | `toon-flatten`   | Uniform-row places with scalar fields → −14%               |
| `apify/rag-web-browser`            | `json`           | Prose-dominated; format-neutral → ±0%                      |
| `apify/instagram-scraper`          | `json`           | Heterogeneous nested fields + captions → +3.5% if forced   |
| `apify/instagram-post-scraper`     | `json`           | Same — caption-heavy → +2.3% if forced                     |

Any static rule (per tool, per Actor) would have to guess the shape of
the next call. The adaptive picker doesn't guess — it encodes both and
picks the smaller — at the cost of one extra `encode()` per response.

## Use in Code Mode ([PR #794](https://github.com/apify/apify-mcp-server/pull/794))

[Code Mode](https://github.com/apify/apify-mcp-server/pull/794) introduces
a `code` MCP tool category where the agent submits a TypeScript program
that orchestrates Apify resources through typed bindings inside a
sandboxed `workerd` isolate. Most intermediate results never enter the
LLM context — only what the submitted code prints (via `console.log`)
shows up in `content[0].text`.

TOON shrinks results that flow through; Code Mode skips most of them
entirely. The two compose well by exposing the picker's encoder as a
binding helper:

```ts
apify.stringifyCompact(value: unknown): string
// Returns min(json, toon-flatten) of `value` as a string.
// Mirrors JSON.stringify, but ships whichever encoding is smaller.
// Use before console.log when the agent needs to surface structured
// data to the caller LLM.
```

Typical usage in agent-submitted code:

```ts
const places = await apify.dataset.listItems({
  datasetId,
  fields: ['title', 'url', 'totalScore'],
  limit: 100,
});
console.log(apify.stringifyCompact(places));
```

Any implementation of the picker should expose its encoder via a
reusable helper so Code Mode (and any future caller) can adopt it
without duplication.

## Trade-offs

### Pros

- **−6.2%** bytes combined across the 18 fixtures; the four list
  endpoints save **19–44%**.
- Single universal recipe. No per-tool field allowlists, no
  shape-specific helpers.
- Bounded by construction — `json` is always a candidate; picker never
  ships larger than today. Defensive `try`/`catch` means a buggy
  encoder downgrade never fails a tool call.
- `structuredContent` and `outputSchema` are untouched; only
  `TextContent.text` shifts.
- Self-tuning — no static config drifts as Actor outputs evolve.
- `_meta.com.apify/encodingStrategy` enables per-tool win-rate
  telemetry.

### Cons

- Extra encode cost — one `encode()` + one `JSON.stringify` per
  response, plus a byte comparison. Measured on synthetic workloads:
  **+0.7 ms** for a 100-item payload at our deepest real-data depth,
  **+1.6 ms** for a 100-item payload at chain-depth 20 (well beyond
  anything observed in production). Under 1% of typical tool-call
  latency.
- LLM behaviour change unmeasured. JSON-trained LLMs may underperform
  on TOON. Quantify via `evals/workflows/` (master vs branch diff on
  `results.json`) before merge.
- Savings concentrate on the four list endpoints; `dataset-items`
  averages near zero. Worthwhile because of *where* it helps, not
  uniform wins.

---

## Verified

- **MCP spec (`2025-11-25`).** `TextContent.text` accepts any string.
  `structuredContent` and `outputSchema` are untouched. Spec-compliant
  clients pass `text` through to the model as-is; no client changes
  needed.

## Before merging an implementation

1. Run the workflow regression eval. Gate merge on no LLM task-success
   regression in `evals/workflows/results.json` vs master.
2. Confirm encode overhead under production load.

## Out of scope

- Token-count measurement (tokenizer-dependent; bytes are the
  reproducible proxy).
- Per-tool static encoding decisions (adaptive replaces them).
- Changes to `structuredContent` or `outputSchema`.

## References

- TOON: <https://toonformat.dev/> · <https://github.com/toon-format/toon>
- MCP spec: <https://modelcontextprotocol.io/specification/2025-11-25>
