# mcpc e2e suite — v1 behavior pin

> **TEMPORARY.** Scaffolding for the stateless migration (#1128), not a permanent suite. Delete
> this directory, the `e2e` project in `vitest.config.ts` and the `test:e2e` script when #1128
> closes. `tests/integration/suite.ts` stays the permanent suite — do not move coverage in here,
> and do not wire this into CI.

Disposable harness that pins the **v1 (legacy sessionful) protocol surface** across the stateless
migration (#1128).

It runs in two modes from one table:

- **Assertive** — cases with an `assert` fail loudly. `pnpm run test:e2e`.
- **Differential** — every case snapshots its output; capture two builds and diff. No expectations
  are authored, so coverage can be exhaustive without a maintenance burden.

## Running

```bash
# Assertive
pnpm run test:e2e

# Snapshot the current build
pnpm run build
E2E_SNAPSHOT_DIR=/tmp/e2e/head pnpm exec vitest run --project e2e

# Snapshot the pre-migration baseline and diff
git worktree add ../v1-base 0ca21c6
(cd ../v1-base && pnpm install && pnpm run build)
E2E_SERVER_ENTRY=$PWD/../v1-base/dist/stdio.js \
  E2E_SNAPSHOT_DIR=/tmp/e2e/base pnpm exec vitest run --project e2e
diff -r /tmp/e2e/base /tmp/e2e/head
```

`0ca21c6` is the baseline: the last commit before `432289e` (#1127), the first migration PR.

| Variable | Effect |
|---|---|
| `E2E_SERVER_ENTRY` | Server to probe. Default `dist/stdio.js`. |
| `E2E_SNAPSHOT_DIR` | Write normalized output to `<dir>/<config>/<case>.json`. |
| `E2E_HTTP_BASE` | Base URL for HTTP configs, e.g. `http://localhost:3001`. Those configs are skipped when unset. |

Requires `jq` on PATH. `mcpc` is resolved from `node_modules/.bin`, so bare `vitest` works too.

## Structure

`cases.json` holds `configs` (server configurations) and `cases` (probes). Case fields:

| Field | Meaning |
|---|---|
| `assert` | jq filter run with `-e`. Optional — without it the case is snapshot-only. |
| `expectError` | Expect a non-zero mcpc exit. Protocol errors exit 2 and write JSON to stderr. |
| `capture` | jq filters stored for `{{name}}` interpolation in later cases of the same config. |
| `redact` | Run the snapshot through `redact.jq`. Required for anything embedding IDs or timings. |

Cases run in array order within a config, and `capture` values flow forward. Two orderings matter:
`gets the finished task result` sits last because `tasks-result` errors while the task is still
working, and the abort/cancel probes need their target created first.

Two error classes, both measured:

| Class | Example | Exit | Payload |
|---|---|---|---|
| Tool-level | bad dataset id, forbidden URL | 0 | `{content, isError: true}` on stdout |
| Protocol | unknown tool, missing required arg | 2 | `{"error": …}` on stderr |

## Secrets

Snapshots are scrubbed of two credentials. **Do not commit snapshot directories** regardless.

- mcpc's `_mcpc` envelope carries the resolved `APIFY_TOKEN` in plaintext. It is stripped from
  every payload before assertions, snapshots and failure messages.
- `urlSigningSecretKey` (per-store signing secret) is redacted by `redact.jq`.

## Reading a diff

Two diffs are expected and benign:

1. **`serverInfo.version`** in every `server-info.json` — a release bump, not behavior.
2. **`add-actor` absent in HEAD** — #1144 deleted it deliberately. Shows up in the `retired-*`
   configs' `tools-list.json` and in `toolNames`.

One known noise source:

3. **`storages.datasets.books.itemCount`** in `calls-an-actor-and-waits` — the test Actor writes to
   a *named* dataset that persists across runs, so its count moves. Not redacted, because
   `itemCount` on the default dataset is real signal.

Anything else is a finding.

Probes that read mutable account state cannot be compared across two sequential runs; the counters
and totals that move on every read are redacted for that reason.

## What this cannot cover

mcpc is a request/response client driven from a shell. These parts of the v1 surface are out of
reach here and are **not** pinned by this harness — check them another way before releasing:

| Not covered | Why | Where it belongs |
|---|---|---|
| `notifications/progress` | mcpc does not surface server notifications | `tests/integration/suite.ts` |
| `notifications/message` filtering | `logging-set-level` round-trips, but delivered logs are invisible | `tests/integration/suite.ts` |
| `_meta.apifyToken` on `tools/call` | mcpc sends no custom `_meta` | `tests/integration/suite.ts` |
| Concurrent session isolation | one session per config, opened and closed in sequence | verified manually; needs two live sessions |
| HTTP wire level (`GET /` 405, `POST /` without session 404, `DELETE /`) | not MCP traffic | `actor.server_streamable.test.ts` |
| `notifications/tools/list_changed` | no v1 tool mutates the list post-connect | not applicable |

The HTTP configs pin **per-session query-param resolution** (`?tools=`, `?ui=`, `?payment=`), not
simultaneous isolation.

## Environment sensitivity

Some probes depend on outbound network reach and will return `isError` on restricted networks. That
does not break the diff — the same failure appears on both sides — but the probe stops carrying
signal:

- `search-apify-docs` and `fetch-apify-docs` for `https://crawlee.dev`.
- Anything touching `apify/example-mcp-server` (the MCP-proxy probes). Note that
  `--tools=apify/example-mcp-server` legitimately loads **no** tools when the Actor is unreachable,
  since loading an MCP-server Actor means connecting to it and enumerating its tools.

The `no-token` config relies on `~/.apify/auth.json` being absent. `stdio.ts` falls back to that
file, so a developer logged into the `apify` CLI silently gets a token and the config stops testing
what it claims. It also has to select `--tools=docs`: with auth-requiring tools the server calls
`process.exit(1)` and there is no session to probe.
