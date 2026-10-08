# Apify API tool eval cases

Review material for the eval cases of the four Apify API tools: `apify-api-search`, `apify-api-details`, and
`apify-api-read` (the opt-in `api` category, from #1444), and `apify-api-write` (#1445), which is in no category: a
session gets it only by naming it in `tools`. They sit next to the rebuilt cases of #1421 but are promoted on their own
schedule, in two batches as those two PRs merge. Delete once they are promoted into the live datasets.

**The cases are uncalibrated.** Nothing here has run against the live Apify API or Langfuse. Expect case fixes during
calibration.

## The files

| File | What |
|---|---|
| `api_tools_pr_cases.json` | 26 `tool-call` cases for `mcp-server-evals-pr`: 13 positive, 13 routing |
| `api_tools_merge_cases.json` | 15 `agent` cases for `mcp-server-evals-merge`: 4 easy, 6 medium, 5 hard. 9 set `expectedErrors` |
| `evals/scripts/api_fixtures.ts` | Deletes leftovers, seeds the merge fixtures, and resets their state (`pnpm run evals:mcp-agent:api-fixtures`) |

The JSON uses the flat shape and field order of `new_pr_cases.json` and `new_merge_cases.json`. `expectedErrors` goes
after `tools`, where most of #1421's merge cases put it. `merge/api/webhooks-raw-json-easy` has no `mcpToolsOnly` on
purpose (see Design choices). The cases are not in `current_status.json` or `case_mapping.json`: they have not run, and
no v1 case covers these tools. The ids are final, so do not edit one; an edited id burns the old one.

To turn a flat case into a Langfuse dataset-item create body:

```bash
jq -c --arg ds mcp-server-evals-pr '.[] | {datasetName: $ds, id, input: {query}}
    + (if has("reference") then {expectedOutput: .reference} else {} end)
    + {metadata: del(.id, .query, .reference)}' api_tools_pr_cases.json
```

Checked offline:

- Every case converts with `toMcpAgentTestCase()` (`evals/langfuse/dataset.ts`) and converts back to the same flat case.
- The 41 ids are unique and none matches an id in #1421's case files.
- Every tool in `expectedTools` and `expectedErrors` exists on master, #1444 (`5c1a53c8`), or #1445 (`330c8bca`). Every
  `tools` selector is a category on #1445, except `apify-api-write`, a tool name.
- `evals/scripts/api_fixtures.ts` passes type-check, lint, and format on this branch. It has not run.
- Search ranking, methods per path, and closest-path suggestions were checked by running the server's own
  `searchApiOperations`, `findPathOperations`, and `findClosestApiPaths` on the apify-docs OpenAPI source from
  2026-07-13, not the live spec. The probes below repeat them on the live spec.

## What the cases measure

Routing. A task no dedicated tool does (webhooks, billing usage and limits, an Actor's environment variables and default
memory, renaming a dataset) must go to the API tools. A task a dedicated tool does (running an Actor, an Actor's last
run, dataset items, starting a build, creating or changing a schedule) must not.

`apify-api-read` and `apify-api-write` refuse no path, and four GET operations start a paid run: `run-sync` and
`run-sync-get-dataset-items`, for Actors and for tasks. So routing is what keeps an agent off them. The pr cases check
the choice between an API tool and the tools next to it: a run goes to `call-actor`, never to either API tool
(`api-loaded-run-actor`, `api-loaded-hello-world`, `api-loaded-run-and-wait`); a read stays a read when a write is close
(`webhook-ever-fired`, where a test delivery is the write); a setting change goes to `apify-api-write`, not to a run
(`default-memory`); and a change a dedicated tool makes goes to that tool (`api-loaded-schedule-time`).

Every case loads `actors, docs, runs, storage, tasks, schedules, builds, dev, api`. That is #1421's set with `builds`
(for the build routing case) and `api` added, and with `apify/rag-web-browser` and `apify/web-fetch` left out. The
server fetches those two Actors' input schemas at startup, #1421 measured that this races the agent at concurrency 2
and above, and CI runs at the runner default of 8.

The `api` category serves search, details, and read. `apify-api-write` is served only when named, so 27 cases also
name it: every case that asks for a write, every routing case (the dedicated tool must win over the whole API family),
and the three where a write is the wrong move (`webhook-ever-fired`, `webhook-create-fields`, and
`merge/api/webhook-fields-easy`). The 14 cases that only read leave it out.

## Design choices

- **`mcpToolsOnly: true` on every case but one.** With built-ins on, `ToolSearch` uses up one of the two turns a
  tool-call case gets (#1421's finding). The exception, `merge/api/webhooks-raw-json-easy`, keeps the built-ins so that
  Claude Code's `ReadMcpResourceTool` is offered next to `apify-api-read`. The Claude Code subprocess inherits
  `process.env`, `APIFY_TOKEN` included, so a Bash `curl` could return the true body. The reference fails that route,
  since the case measures which MCP route the agent takes.
- **Wide `expectedTools` on the positive cases.** The read and write descriptions tell the agent to look an operation up
  with `apify-api-details` first, so search, details, and the call are all defensible first moves. So is a read before a
  write (`get-dataset`, `fetch-actor-details`, `apify-api-read`), and so is looking up an Actor that the query names
  without its username. `resurrect-run` and `sign-json` also accept the direct call: details on the exact path needs the
  same knowledge as the call. `sign-json` also accepts the docs tools, as `webhook-create-fields` does, since a docs
  search finds the endpoint. The positive cases catch refusing or answering from memory; the 9 that accept a dedicated
  lookup do not catch a first call outside the API family.
- **Lookups on the routing cases.** `api-loaded-build` accepts `fetch-actor-details` and `get-actor-build-list` next
  to `build-actor`, whose `actor` argument needs an ID or `username/name` the query does not give.
- **No `expectedArgs`.** The path is free-form (`webhooks`, `v2/webhooks`, and `/v2/webhooks` are the same), and not
  every accepted tool has a `method` key. The merge references check paths and bodies instead.
- **The resource counts as a read in the merge cases only.** Every merge read reference accepts `ReadMcpResourceTool`
  with the same `https://api.apify.com/v2/...` URI, since it reaches the same endpoint with the same token. The pr cases
  do not list it in `expectedTools` (agreed with the maintainer): a tool-call case expects the tool that does the job,
  or a lookup before it. `webhooks-raw-json-easy` is the one case that measures the choice.
- **Queries do not reuse the descriptions' examples.** The tool descriptions quote the acceptance tasks almost verbatim,
  so the queries word the same tasks differently and test the descriptions rather than repeat them.
- **Routing categories differ from #1421.** As in #1421, a pr id names the asserted tool: a positive case's id and
  category name the API tool it asserts, and a routing case's id names the dedicated tool that must win
  (`pr/get-actor-run-list/api-loaded-last-run`). A routing case's category is `apify-api-routing`, not that tool, and
  its slug starts with `api-loaded-`. So `--category apify-api-routing` selects the routing cases, and
  `--category apify-api-search` selects the two cases where search is the expected first move. A merge id ends with its
  difficulty, so `--id 'easy$'` selects a wave.
- **`expectedErrors` is per tool, not per call.** On `merge/api/old-path-404-hard` it also exempts a failed follow-up
  read of `/v2/users/me/usage/monthly`; the reference narrows that by failing an answer that says the read failed and
  still gives a total. On `merge/api/env-var-missing-hard`, a read that 404s on a wrong `username~` prefix looks like a
  missing variable to the judge.
- **Recovered lookups do not fail an item.** `webhooks-list-easy`, `env-vars-list-medium`, `webhook-test-medium`,
  `webhook-lifecycle-medium`, `env-var-missing-hard`, and `secret-env-var-hard` list `fetch-actor-details` in
  `expectedErrors`, so a failed Actor lookup the agent recovers from does not fail an item the judge passes. On
  `webhook-lifecycle-medium` and `secret-env-var-hard` the lookup fails on `eval-api-actor-scratch`, which is never
  built. `old-path-404-hard` lists `fetch-apify-docs`: on master it appends `.md` to a docs link that already ends in
  `.md`, so it 404s on such links. Neither failure is what the cases measure. Drop `fetch-apify-docs` once master fixes
  that.
- **A 404 that confirms a delete does not fail an item.** `dataset-rename-medium` lists `apify-api-read` and
  `get-dataset`, and `webhook-lifecycle-medium` lists `apify-api-read`: a read after the delete answers 404, which
  confirms the delete.

## Coverage

"Exercised, not required" means the reference or `expectedTools` accepts the step but passes without it.

| Tool | Argument group or behavior | Cases |
|---|---|---|
| `apify-api-search` | `query`: finds an operation whose path the agent may not know | Exercised, not required: `pr/apify-api-search/resurrect-run`, `pr/apify-api-search/sign-json` (both also accept the direct call, and `sign-json` the docs tools), `merge/api/webhook-test-medium`, `merge/api/browser-info-medium` |
| | `query` from vague language | Exercised, not required: `merge/api/budget-vague-hard` |
| | Recovery after a 404 | Exercised, not required: `merge/api/old-path-404-hard` (following the 404's closest paths is an equal route) |
| | `limit` | Not covered. No user intent maps to a result count, and the default of 10 serves every case. Unit tests cover it. |
| | Routing: a dedicated tool must win | `pr/search-actors/api-loaded-store-search`, `pr/search-apify-docs/api-loaded-docs-concept` |
| `apify-api-details` | `path` template and `method` given | Exercised, not required: `pr/apify-api-details/webhook-create-fields`, `merge/api/webhook-fields-easy`. Both pass with the docs tools alone. |
| | `method` omitted (every operation on the path) | Exercised, not pinned: `merge/api/dataset-access-method-hard` |
| | Path not in the spec (error) | Exercised, not required: `merge/api/old-path-404-hard`, in `expectedErrors` |
| | Method not on the path (error) | Exercised, not required: `merge/api/dataset-access-method-hard`, in `expectedErrors` |
| | The lookup before a write | Exercised, not required: every `merge/api/*` write case |
| `apify-api-read` | Found, one GET | `pr/apify-api-read/webhooks-on-account`, `spend-this-billing-cycle`, `monthly-spending-cap`, `merge/api/webhooks-list-easy`, `merge/api/monthly-spend-easy` |
| | `~name` and `username~name` paths, chained reads | `pr/apify-api-read/env-var-value`, `env-var-names`, `merge/api/env-vars-list-medium`, `merge/api/env-var-missing-hard` (a bare name fails it) |
| | `query` (`limit`, `desc`) | `merge/api/webhook-deliveries-medium` (the expected call, not required) |
| | 404 on an unknown path, with suggested paths | `merge/api/old-path-404-hard` |
| | 404 on a missing record | `merge/api/env-var-missing-hard` |
| | Token masking (`/v2/browser-info`) | `merge/api/browser-info-medium` |
| | Resource or tool | `merge/api/webhooks-raw-json-easy`. The pr cases do not accept `ReadMcpResourceTool`. |
| | Response over 256 KB, binary body | Not covered. No endpoint without a dedicated tool returns that much on the eval account reliably. Unit tests cover both. |
| | Routing: a dedicated tool must win | `pr/get-actor-run-list/api-loaded-last-run`, `pr/get-dataset-items/api-loaded-dataset-items`, `pr/get-dataset-list/api-loaded-dataset-list`, `pr/get-actor-run-log/api-loaded-run-log` |
| | Routing: a run goes to `call-actor`, not to a `run-sync` GET | `pr/call-actor/api-loaded-run-actor`, `api-loaded-hello-world`, `api-loaded-run-and-wait` |
| | Routing: a read must win over a write (a test delivery) | `pr/apify-api-read/webhook-ever-fired` |
| `apify-api-write` | POST with `body` | `pr/apify-api-write/alert-on-crash`, `secret-env-var`, `merge/api/webhook-lifecycle-medium`, `merge/api/secret-env-var-hard` |
| | POST with `query` | `merge/api/dataset-rename-medium` (`name` query parameter) |
| | POST with neither | `merge/api/webhook-test-medium` |
| | PUT with `body` | `pr/apify-api-write/rename-dataset`, `default-memory`, `merge/api/dataset-rename-medium`, `merge/api/dataset-access-method-hard`. `merge/api/secret-env-var-hard` accepts a version PUT but does not require it. |
| | DELETE | `merge/api/webhook-lifecycle-medium`, `dataset-rename-medium`, `secret-env-var-hard` |
| | `method` omitted, several methods (refused) | Not covered; unit tests cover it. `merge/api/dataset-access-method-hard` does not exempt it: the method parameter says to omit the method only when the path has one, so the error gate fails a write without a method there. |
| | `method` omitted, one method (inferred) | Exercised, not pinned: `merge/api/webhook-test-medium` (`/test` has only POST) |
| | `method` omitted on a GET-only path (refused, names the read tool) | Not covered. Unit tests cover it. |
| | PATCH | Not covered. The July spec has no PATCH operation; probe 1 checks the live spec. |
| | Write whose response is over 256 KB | Not covered. Unit tests cover it. |
| | Secret semantics (`isSecret`) | `pr/apify-api-write/secret-env-var`, `merge/api/secret-env-var-hard` |
| | Change only what was asked | `merge/api/secret-env-var-hard` (EVAL_MODE must survive), `merge/api/dataset-access-method-hard` (no rename) |
| | Routing: a setting change must not become a run (`call-actor` must lose) | `pr/apify-api-write/default-memory` |
| | Routing: a dedicated tool must win | `pr/build-actor/api-loaded-build`, `pr/call-actor/api-loaded-run-actor`, `api-loaded-hello-world`, `api-loaded-run-and-wait`, `pr/create-schedule/api-loaded-schedule`, `pr/update-actor-task/api-loaded-task-input`, `pr/update-schedule/api-loaded-schedule-time` |

No case requires `apify-api-search` or `apify-api-details`. A strong model knows most paths, every pr case that accepts
a lookup also accepts the call, and the docs tools answer every question `apify-api-details` answers, since
docs.apify.com hosts the API reference. Whether agents use the lookup tools shows in the transcripts, not in the scores.

The acceptance tasks of the API tools issue (#1443):

| Task | Cases |
|---|---|
| List webhooks | `merge/api/webhooks-list-easy`, `merge/api/webhooks-raw-json-easy`, `pr/apify-api-read/webhooks-on-account` |
| Rename a dataset | `merge/api/dataset-rename-medium`, `pr/apify-api-write/rename-dataset` |
| Read monthly usage | `merge/api/monthly-spend-easy`, `merge/api/old-path-404-hard`, `pr/apify-api-read/spend-this-billing-cycle` |
| List an Actor's environment variables (asked for on top of the issue's three) | `merge/api/env-vars-list-medium`, `pr/apify-api-read/env-var-names` |

## Fixtures

The merge cases use fixed `eval-api-*` names and three permanent fixtures, which `api_fixtures.ts` creates and resets:

- `eval-api-actor`, read-only: version 0.0 alone, with `EVAL_REGION=eu-central-1` (plain) and `EVAL_API_KEY` (secret),
  plus one webhook that calls `https://example.com/eval-api/run-failed` when a run fails. The read cases assert on it.
- `eval-api-actor-scratch`, edited by the write cases: version 0.0 alone, with `EVAL_MODE=scratch` (plain).
- `eval-api-shared`, a dataset the access case opens to anyone with the link. Reset to `RESTRICTED`.

The two Actors are separate because cases run concurrently against one account. Neither is ever built or run, so the
fixture webhook never fires on its own and nothing costs compute. The script deletes leftover `eval-api-*` datasets and
Actors, and every webhook that watches a fixture Actor or calls an `https://example.com/eval-api/` URL. It deletes on
whatever account `APIFY_TOKEN` points at and prints that account first; `--dry-run` shows what it would change.

`merge/api/dataset-rename-medium`, `webhook-lifecycle-medium`, and `secret-env-var-hard` create fixed names, and
`dataset-access-method-hard` edits a fixture every trial shares. They are not safe under `--iterations` above 1 without
`--concurrency 1`, nor when two runs use the account at once. This is the same limit the schedule cases have today.
Once the run-scoped names from #1423 are on master, these four cases move to them the way the schedule cases do: a
`-{{uniq}}` suffix on every name they create, and their own resource instead of the shared `eval-api-shared` dataset and
the scratch Actor's variables.

## Probes before upserting

The cases assume these facts. Check each against the live API on the account CI uses (`APIFY_TEST_USER_API_TOKEN`),
after `api_fixtures.ts` has run, and put the date in the README section.

Spec (`https://docs.apify.com/api/openapi.json`, through the server's own index):

1. There is no PATCH operation. `/v2/datasets/{datasetId}` has GET, PUT, and DELETE. `/v2/webhooks` has GET and POST.
   `/v2/webhooks/{webhookId}/test` has only POST. The env-var create is
   `POST /v2/actors/{actorId}/versions/{versionNumber}/env-vars`.
2. `POST /v2/webhooks` requires `eventTypes`, `condition`, and `requestUrl`. Print the body schema's `required` array in
   full.
3. Search returns the target operation in the top 3 for: list webhooks, monthly usage, limits, rename dataset,
   environment variables, test webhook, webhook dispatches, browser info, resurrect run, and sign object. It returns
   nothing useful for "ip address", "budget", and "resume run" (Found while drafting, 1).
4. Closest paths: `users/me/usage` suggests `/v2/users/me/usage/monthly` first. For
   `actors/~eval-api-actor/versions/0.0/env-vars/EVAL_TIMEZONE`, `/v2/actors` currently ranks first.

Platform:

5. `~name` resolves the token's own resources: `GET /v2/actors/~eval-api-actor` and `GET /v2/datasets/~eval-api-shared`
   return 200. So does `username~name`: `GET /v2/datasets/{username}~eval-api-shared` returns 200.
6. The account can create private Actors with a `SOURCE_FILES` version and `envVars` (including `isSecret: true`)
   without a build, and its plan allows two more Actors.
7. `GET .../versions/0.0/env-vars` returns the plain value of EVAL_REGION and no value for EVAL_API_KEY. The version
   list, the version, and the Actor object carry `envVars` the same way.
8. `GET .../env-vars/EVAL_TIMEZONE` returns 404, and so does `GET /v2/users/me/usage`. Record both error types.
9. `POST /v2/datasets` reads the name only from the `name` query parameter, so a body-only `name` creates an unnamed
   dataset. A second POST with an existing name returns the existing dataset. Renaming onto a taken name fails; record
   the error type.
10. `PUT /v2/datasets/{id}` with only `generalAccess: ANYONE_WITH_ID_CAN_READ` works on the account's plan and keeps the
    name.
11. `POST /v2/webhooks` needs `condition.actorId` to be an ID. If it also takes `~eval-api-actor-scratch` or
    `username~name`, widen `webhook-lifecycle-medium`; if it refuses a name, settle Open questions, 7 before
    calibrating. `description` is stored, and the list returns it and `condition`.
12. `POST /v2/webhooks/{id}/test` returns a dispatch (record its status), sends one POST to the example.com URL, and
    works for a webhook whose Actor never ran.
13. `GET /v2/webhook-dispatches?limit=3&desc=1` honors both parameters.
14. `POST .../env-vars` with `isSecret: true` returns `isSecret: true` and no value, and DELETE removes it. If
    `PUT .../env-vars/{name}` on a missing name creates it, add that PUT to the create routes in `secret-env-var-hard`.
15. `GET /v2/users/me/limits` has `limits.maxMonthlyUsageUsd` and `current.monthlyUsageUsd`, the spend of the current
    period. `GET /v2/users/me/usage/monthly` has a USD total and the cycle dates. The references do not assume the two
    totals are equal.
16. `GET /v2/browser-info` echoes the `Authorization` header raw. Print only whether the body contains the token, never
    the token. Unit tests cover the masking in `apify-api-read`. The resource returns the body as it is (Found while
    drafting, 5).
17. A bare name without `~` is read as an ID: `GET /v2/actors/eval-api-actor` and `GET /v2/datasets/eval-api-shared`
    return 404. The legacy `acts/` prefix reaches the same endpoint as `actors/`.
18. The webhook list returns `requestUrl` and `lastDispatch`. Record what `lastDispatch` holds:
    `webhook-deliveries-medium` says it is at most one delivery per webhook.
19. The items of `GET /v2/webhook-dispatches` include `calls[].responseStatus`. If not,
    `GET /v2/webhook-dispatches/{id}` does; record which.
20. `GET /v2/users/me` has the plan's included monthly usage in USD. If not, drop `/v2/users/me` from
    `budget-vague-hard`.
21. `PUT /v2/actors/{actorId}/versions/0.0` with only `envVars` replaces the version's variables, keeps its source files,
    and stores a variable with `isSecret: true` as a secret.

Harness:

22. Does `tools: []`, which `mcpToolsOnly` sets, remove Claude Code's `ReadMcpResourceTool`? Check the first staging
    run's transcripts. No case depends on the answer, but it decides whether `webhooks-raw-json-easy` is the only case
    that can show the resource route (Open questions, 8).
23. A refusal from `respondUserError` (method missing, path not in the spec) reaches the gate as a failed tool call.
    `old-path-404-hard` and `dataset-access-method-hard` assume it does.

<details><summary>Throwaway probe script</summary>

Write it as `evals/scripts/probe_api_tmp.ts` in a checkout of #1445's branch, run it with `APIFY_TOKEN` set, delete it,
and run `api_fixtures.ts` again to sweep what it left. Every print goes through `redact()`, since `GET /v2/browser-info`
echoes the token, and `users/me` prints no body, since it holds the proxy password.

```ts
import 'dotenv/config';

import { ApifyClient } from 'apify-client';

import { findClosestApiPaths, findPathOperations, normalizeApiPath } from '../../src/tools/api/apify_api_request.js';
import { fetchApiOperationIndex, searchApiOperations } from '../../src/tools/api/apify_api_spec.js';

const token = process.env.APIFY_TOKEN ?? '';
const client = new ApifyClient({ token });

function redact(text: string): string {
    return token ? text.replaceAll(token, '[REDACTED]') : text;
}

function show(label: string, value: unknown): void {
    console.log(`  ${label}:`, redact(JSON.stringify(value) ?? 'undefined'));
}

function scalars(value: unknown): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries((value as object | undefined) ?? {}).filter(([, v]) => v === null || typeof v !== 'object'),
    );
}

/** One request as the API tools send it: once, any status back. `preview: false` prints the status only. */
async function call(method: string, path: string, body?: unknown, { preview = true } = {}): Promise<any> {
    const response = await client.httpClient.axios.request({
        url: `${client.baseUrl}/${path}`,
        method,
        ...(body !== undefined && { data: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    });
    const shown = preview ? redact(JSON.stringify(response.data) ?? '').slice(0, 500) : '';
    console.log(`${method} /v2/${path} -> ${response.status}`, shown);
    return response.data;
}

// Spec facts 1-4.
const index = await fetchApiOperationIndex();
console.log('PATCH:', [...index.values()].filter((o) => o.method === 'PATCH').map((o) => o.path));
for (const p of ['datasets/x', 'webhooks', 'webhooks/x/test', 'actors/x/versions/0.0/env-vars', 'browser-info'])
    console.log(p, findPathOperations(index, normalizeApiPath(p)).map((o) => o.method));
const createWebhook = findPathOperations(index, 'webhooks').find((o) => o.method === 'POST');
show('POST /v2/webhooks required', (createWebhook?.requestBody?.schema as { required?: unknown } | undefined)?.required);
for (const q of ['list webhooks', 'monthly usage', 'limits', 'rename dataset', 'environment variables', 'test webhook',
    'webhook dispatches', 'browser info', 'ip address', 'budget', 'resurrect run', 'resume run', 'sign object'])
    console.log(q, '=>', searchApiOperations(index, q, 3).map((o) => `${o.method} ${o.path}`));
for (const p of ['users/me/usage', 'actors/~eval-api-actor/versions/0.0/env-vars/EVAL_TIMEZONE'])
    console.log(p, '=>', findClosestApiPaths(index, normalizeApiPath(p)));

// Platform facts 5-21.
const me = await call('GET', 'users/me', undefined, { preview: false });
const actor = await call('GET', 'actors/~eval-api-actor');
show('Actor versions', actor.data?.versions?.map((v: any) => ({ versionNumber: v.versionNumber, envVars: v.envVars })));
await call('GET', 'acts/~eval-api-actor');
await call('GET', 'actors/eval-api-actor');
await call('GET', 'datasets/~eval-api-shared');
await call('GET', `datasets/${me.data?.username}~eval-api-shared`);
await call('GET', 'datasets/eval-api-shared');
show('env-vars list', (await call('GET', 'actors/~eval-api-actor/versions/0.0/env-vars')).data?.items);
show('version envVars', (await call('GET', 'actors/~eval-api-actor/versions/0.0')).data?.envVars);
await call('GET', 'actors/~eval-api-actor/versions/0.0/env-vars/EVAL_TIMEZONE');
await call('GET', 'users/me/usage');
const monthly = await call('GET', 'users/me/usage/monthly');
show('usage/monthly cycle', monthly.data?.usageCycle);
show('usage/monthly top-level values', scalars(monthly.data));
show('limits', (await call('GET', 'users/me/limits')).data);
show('users/me plan', me.data?.plan);
const browserInfo = await call('GET', 'browser-info');
console.log('  browser-info echoes the token:', token !== '' && JSON.stringify(browserInfo).includes(token));

const bodyOnly = await call('POST', 'datasets', { name: 'eval-api-probe-body' });
const named = await call('POST', 'datasets?name=eval-api-probe');
await call('POST', 'datasets?name=eval-api-probe');
await call('PUT', `datasets/${named.data.id}`, { name: 'eval-api-shared' });
await call('PUT', `datasets/${named.data.id}`, { generalAccess: 'ANYONE_WITH_ID_CAN_READ' });
await call('DELETE', `datasets/${named.data.id}`);
await call('DELETE', `datasets/${bodyOnly.data.id}`);

const scratch = await call('GET', 'actors/~eval-api-actor-scratch');
const hook = { eventTypes: ['ACTOR.RUN.FAILED'], requestUrl: 'https://example.com/eval-api/probe', description: 'probe' };
const byName = await call('POST', 'webhooks', { ...hook, condition: { actorId: '~eval-api-actor-scratch' } });
if (byName.data?.id) await call('DELETE', `webhooks/${byName.data.id}`);
const created = await call('POST', 'webhooks', { ...hook, condition: { actorId: scratch.data.id } });
await call('POST', `webhooks/${created.data.id}/test`);
const webhooks = await call('GET', 'webhooks');
show('webhook list', webhooks.data?.items?.map((w: any) => ({
    id: w.id, requestUrl: w.requestUrl, description: w.description, condition: w.condition, lastDispatch: w.lastDispatch,
})));
await call('GET', `webhooks/${created.data.id}/dispatches`);
const dispatches = await call('GET', 'webhook-dispatches?limit=3&desc=1');
show('dispatches', dispatches.data?.items?.map((d: any) => ({
    id: d.id, createdAt: d.createdAt, status: d.status, responseStatuses: d.calls?.map((c: any) => c.responseStatus),
})));
const [newest] = dispatches.data?.items ?? [];
if (newest) show('newest dispatch calls', (await call('GET', `webhook-dispatches/${newest.id}`)).data?.calls);
await call('DELETE', `webhooks/${created.data.id}`);

const envVars = `actors/${scratch.data.id}/versions/0.0/env-vars`;
await call('POST', envVars, { name: 'EVAL_PROBE_SECRET', value: 'probe', isSecret: true });
await call('GET', envVars);
await call('PUT', `${envVars}/EVAL_PROBE_MISSING`, { name: 'EVAL_PROBE_MISSING', value: 'probe' });
await call('DELETE', `${envVars}/EVAL_PROBE_SECRET`);
await call('DELETE', `${envVars}/EVAL_PROBE_MISSING`);

const scratchVersion = `actors/${scratch.data.id}/versions/0.0`;
const mode = { name: 'EVAL_MODE', value: 'scratch', isSecret: false };
const secret = { name: 'EVAL_PROBE_SECRET', value: 'probe', isSecret: true };
const withSecret = await call('PUT', scratchVersion, { envVars: [mode, secret] });
show('version PUT with the secret', { envVars: withSecret.data?.envVars, sourceFiles: withSecret.data?.sourceFiles?.length });
show('version PUT without it', (await call('PUT', scratchVersion, { envVars: [mode] })).data?.envVars);
```

</details>

## Found while drafting

These come from the July spec and the server's own functions, so check each on the live spec. None needs a case change;
they are why some hard cases exist.

1. **Search misses natural words.** "ip address", "budget", and "resume run" find nothing useful, and "request headers"
   returns request queues. `browser-info-medium` and `budget-vague-hard` depend on the agent retrying with other words.
   If Haiku fails there, the fix is on the search side, for example matching descriptions as well as summaries.
2. **Closest-path suggestions misled on a missing record.** Every 404 from the call tools listed "the closest paths in
   the API spec", even when the path was right and only the record was missing, and for a missing env var the list
   started with `/v2/actors`, ahead of the env-var template the path matches. #1444 now lists them only for a
   `page-not-found` 404, a path the API does not have. `env-var-missing-hard` measures whether agents blame the path for
   a missing record, and its reference passes with or without the list.
3. **The server instructions send model reads to the resource.** They tell the agent to pass any `/v2/...` GET URL to
   `resources/read`, even when `apify-api-read` is loaded. If `webhooks-raw-json-easy` shows agents taking the resource
   when the tool is there, gate that guidance on the tool being loaded.
4. **The descriptions decide what a tool-call case can assert.** The write description says to call details first, so
   no pr case can require `apify-api-write` as the first call. That is why the lists are wide.
5. **The resource returns `/v2/browser-info` with the token in it.** `apify-api-read` masks it; the resource returns the
   body as it is. `browser-info-medium` accepts both routes and fails an answer that contains the token either way.

## Staging and promotion

CI reads the shared datasets live on every run. Upserted before #1444 is on master, these cases would run against a
server without the `api` category, and the session would have no API tools:

- **pr tier:** 9 of the 13 positive cases also accept a first call to a tool already on master (`fetch-actor-details`,
  `get-dataset`, `get-dataset-list`, `get-actor-run`, or the docs tools), and the 13 routing cases pass trivially. The
  tier would likely stay above its 0.9 gate while measuring nothing about the API tools: against today's live pr dataset
  (111 of 115 passing on a hosted run), 3 of those 9 passing give 127 of 141, a rate of 0.901. Only
  `webhooks-on-account`, `spend-this-billing-cycle`, `monthly-spending-cap`, and `webhook-ever-fired` would fail.
- **merge tier:** most of the 15 cases fail. The tier stays above its 0.6 gate, but real regressions would hide behind
  expected failures, and the write cases would run without fixtures.

The pr cases do not accept `ReadMcpResourceTool`, so a read case cannot pass through the resource, which is on master
already, before #1444 merges.

Langfuse item ids are unique per project forever and cannot move between datasets, so the cases are calibrated in
staging datasets under burned ids and promoted under the final ids:

1. Create `mcp-server-evals-pr-api-staging` and `mcp-server-evals-merge-api-staging`, and upsert every case there with
   its id prefixed `stage-api/`.
2. Calibrate from a checkout of #1445's branch, which contains #1444: Opus first, then Sonnet and Haiku, at
   `--concurrency 1`, reading every transcript. Run the merge waves in order (easy, medium, hard) and re-seed the fixtures
   before each. Fix cases until Opus passes them all.
3. Add the README section and the CI step below with #1444, or in an evals PR merged right after it.
4. **Batch A, after #1444 is on master** and the fixtures have run once on the CI account: the 16 pr cases and 10 merge
   cases that need only search, details, and read. That is every case except the ones in Batch B. The three
   `pr/call-actor/api-loaded-*` cases are here because a `run-sync` GET through `apify-api-read` already starts a run.
   Upsert Batch A without `apify-api-write` in `tools`: a server without the write tool reads that name as an Actor and
   fetches it at startup, the race the two default Actors are left out for. If pinned dataset versions (#1395) have
   landed by then, promotion is the upsert plus a pin bump in #1444 itself, so the cases go live exactly when the
   tools merge; otherwise the upsert follows the merge.
5. **Batch B, after #1445 is on master:** the 10 write-dependent pr cases and the merge cases `webhook-lifecycle-medium`,
   `dataset-rename-medium`, `webhook-test-medium`, `secret-env-var-hard`, and `dataset-access-method-hard`. The 10 pr
   cases are the four `pr/apify-api-write/*` cases, `resurrect-run` and `sign-json` (which ask for writes), and the
   four routing cases where only `apify-api-write` competes: `api-loaded-build`, `api-loaded-schedule`,
   `api-loaded-task-input`, and `api-loaded-schedule-time`. Upsert again the 12 Batch A cases that name
   `apify-api-write`, now with it.
6. Archive the staging items and abandon the two staging datasets.

Why two staging datasets of their own rather than #1411's `-v2` staging datasets: those are still in use for the
rebuilt set's calibration, and every `-v2` run would then also run these cases, which fail on any branch without the
`api` category. The two datasets here are temporary in the same way `-v2` is: once the cases are promoted, the live
datasets stay one per tier, with no new suffix. If you'd rather keep a single staging pair, the commands below work with
`-v2` too: run these cases with `--id '^stage-api/'`, and the rebuilt set with `--id '^(?!stage-api/)'`.

Only promote calibrated cases. Anything that still fails on Haiku stays in staging until its cause is known; the pr
tier's 0.9 gate has little room. PR runs check out the merge ref, so once #1444 is on master every PR evaluated builds
with the `api` category. A local run on a branch without master merged has no `api` tools.

Commands, once credentials are in place. `npx` refuses to run inside the repo, so the Langfuse CLI runs from another
directory. Langfuse CLI flags other than `dataset-items create --body-file -` are unverified; check them with `--help`.

```bash
C="$PWD"   # this branch's checkout, with a .env like the #1445 checkout's
R="$C/res/eval_cases_review"
W=/path/to/a/checkout/of/feat/apify-api-write
B_PR='^pr/(apify-api-write/(rename-dataset|alert-on-crash|secret-env-var|default-memory)'
B_PR+='|apify-api-search/(resurrect-run|sign-json)'
B_PR+='|build-actor/api-loaded-build|create-schedule/api-loaded-schedule'
B_PR+='|update-actor-task/api-loaded-task-input|update-schedule/api-loaded-schedule-time)$'
B_MERGE='^merge/api/(webhook-lifecycle-medium|dataset-rename-medium|webhook-test-medium|secret-env-var-hard|dataset-access-method-hard)$'
to_items() { jq -c --arg ds "$1" '.[] | {datasetName: $ds, id, input: {query}}
    + (if has("reference") then {expectedOutput: .reference} else {} end)
    + {metadata: del(.id, .query, .reference)}' "$2"; }
upsert() { while IFS= read -r item; do printf '%s' "$item" | npx -y langfuse-cli api dataset-items create --body-file -; done; }
fixtures() { (cd "$C" && pnpm run evals:mcp-agent:api-fixtures "$@"); }

# Fixtures. Re-run before every merge run.
fixtures --dry-run && fixtures

# Staging datasets and items. Create is an upsert on id, so re-run after any edit.
cd /tmp && export $(grep -E '^LANGFUSE' "$W/.env" | xargs) && export LANGFUSE_HOST="$LANGFUSE_BASE_URL"
for name in mcp-server-evals-pr-api-staging mcp-server-evals-merge-api-staging; do
    printf '{"name":"%s","description":"Staging for the Apify API tool evals. Ids here are burned."}' "$name" \
        | npx -y langfuse-cli api datasets create --body-file -
done
to_items mcp-server-evals-pr-api-staging "$R/api_tools_pr_cases.json" | jq -c '.id = "stage-api/" + .id' | upsert
to_items mcp-server-evals-merge-api-staging "$R/api_tools_merge_cases.json" | jq -c '.id = "stage-api/" + .id' | upsert

# Calibrate, in the #1445 checkout. Repeat with claude-sonnet-5 and claude-haiku-4-5 once Opus passes.
cd "$W"
pnpm run evals:mcp-agent -- --dataset mcp-server-evals-pr-api-staging \
    --agent-model claude-opus-5 --subscription --claude-judge --concurrency 1
fixtures && pnpm run evals:mcp-agent -- --dataset mcp-server-evals-merge-api-staging --id 'easy$' \
    --agent-model claude-opus-5 --subscription --claude-judge --concurrency 1   # then 'medium$', then 'hard$'

# Promote Batch A, without apify-api-write in tools.
cd /tmp
A_SELECT='select(.id | test($b) | not) | .metadata.tools -= ["apify-api-write"]'
to_items mcp-server-evals-pr "$R/api_tools_pr_cases.json" | jq -c --arg b "$B_PR" "$A_SELECT" | upsert
to_items mcp-server-evals-merge "$R/api_tools_merge_cases.json" | jq -c --arg b "$B_MERGE" "$A_SELECT" | upsert

# Promote Batch B: every case that names apify-api-write, the 12 Batch A ones among them.
B_SELECT='select(.metadata.tools | index("apify-api-write"))'
to_items mcp-server-evals-pr "$R/api_tools_pr_cases.json" | jq -c "$B_SELECT" | upsert
to_items mcp-server-evals-merge "$R/api_tools_merge_cases.json" | jq -c "$B_SELECT" | upsert

# Archive the staging items.
to_items mcp-server-evals-pr-api-staging "$R/api_tools_pr_cases.json" \
    | jq -c '.id = "stage-api/" + .id | .status = "ARCHIVED"' | upsert
to_items mcp-server-evals-merge-api-staging "$R/api_tools_merge_cases.json" \
    | jq -c '.id = "stage-api/" + .id | .status = "ARCHIVED"' | upsert
```

A Claude judge scoring a Claude agent can be lenient on itself. Before quoting final numbers, run one merge pass without
`--claude-judge`, which uses OpenRouter.

Turn budgets: easy cases get 8 (one read, or a lookup then a read). Medium cases get 10 to 12 for read chains and 14 for
create, verify, and clean up; `webhook-deliveries-medium` budgets the per-webhook route. Hard cases get 10, or 14 for
`secret-env-var-hard`, budgeted for the recovery path.

## Proposed text for promotion

Not part of this PR. Add with #1444, or in the evals PR right after it.

The CI step, in `.github/workflows/_evaluations.yaml` after "Seed schedule fixtures":

```yaml
            -   name: Seed API fixtures (merge tier only)
                if: inputs.tier == 'merge'
                run: pnpm run evals:mcp-agent:api-fixtures
                env:
                    APIFY_TOKEN: ${{ secrets.APIFY_TOKEN }}
```

For `evals/README.md`, after the web-selection family paragraph in "Two datasets: kind, id scheme, and expectedErrors"
(or with the other family paragraphs, if #1421's migration has rewritten that section by then). Replace the probe date
and correct any fact the probes disprove:

```markdown
The API family (26 `pr` items: 13 `pr/apify-api-*/*` and 13 routing items `pr/*/api-loaded-*` in
category `apify-api-routing`; and `merge/api/*`, 15 items: 6 proper + 9 with `expectedErrors`)
covers the API tools: `apify-api-search`, `apify-api-details`, and `apify-api-read` from the opt-in
`api` category, and `apify-api-write`, which a session gets only by naming it. A routing item's id
names the dedicated tool that must win, as the rest of the `pr` ids name the tool they assert. Every
item loads the same wide tool set, `actors,docs,runs,storage,tasks,schedules,builds,dev,api`, and
all but one set `mcpToolsOnly: true`. The two default Actor tools are left out: the server fetches
their input schemas at startup, which races the agent at CI's concurrency. The items that ask for
a write, every routing item, and the three where a write is the wrong move
(`pr/apify-api-read/webhook-ever-fired`, `pr/apify-api-details/webhook-create-fields`, and
`merge/api/webhook-fields-easy`) also name `apify-api-write`; the items that only read leave it
out. The set is wide because what the family measures is routing: a task no dedicated tool does
(webhooks, billing usage and limits, an Actor's environment variables and default memory, renaming
a dataset) must go to the API tools, and a task a dedicated tool does (running an Actor, an Actor's
last run, dataset items, starting a build, creating or changing a
schedule) must not. `apify-api-read` refuses no path, and a GET of `run-sync` or
`run-sync-get-dataset-items` starts a paid run, so the three `pr/call-actor/api-loaded-*` items
check that a run goes to `call-actor`. The positive `pr` items accept an API lookup
(`apify-api-search` or `apify-api-details`), the API call that does the task, or an API read before
a write as the first call, since the read and write descriptions tell the agent to look an
operation up first. Nine also accept a dedicated lookup (`fetch-actor-details` where the query names
an Actor without its username, `get-dataset`, `get-dataset-list`, `get-actor-run`, or the docs
tools), so they do not catch a first call outside the API family. Even `resurrect-run` and
`sign-json` accept the direct call, so no item requires `apify-api-search` or `apify-api-details`.
The `expectedErrors` exemption is per tool, not per call, which leaves a known blind spot: on
`merge/api/old-path-404-hard` it also covers a failure of the follow-up read of
`/v2/users/me/usage/monthly`, and its reference narrows that by failing an answer that says the read
failed and still gives a total. On `merge/api/env-var-missing-hard`, a read that 404s on a wrong
`username~` prefix looks like a missing variable to the judge. Six items exempt
`fetch-actor-details`, so a failed Actor lookup the agent recovers from does not fail an item the
judge passes.

The `merge/api/*` items use fixed `eval-api-*` names and three permanent fixtures. The Actor
`eval-api-actor` has only version 0.0, with `EVAL_REGION=eu-central-1` and the secret `EVAL_API_KEY`,
plus one webhook that calls `https://example.com/eval-api/run-failed` when a run fails. The read
cases assert on it, and no case may modify it. The Actor `eval-api-actor-scratch` has only version
0.0, with `EVAL_MODE=scratch`, and the write cases edit it. They are separate for the reason the
schedule fixtures are: items run concurrently against one account. The dataset `eval-api-shared` is
the one the access case opens to anyone with the link. Neither Actor is ever built or run, so the
fixture webhook never fires on its own. Run `pnpm run evals:mcp-agent:api-fixtures` before every
run: it deletes leftover `eval-api-*` datasets and Actors, and every webhook that watches a fixture
Actor or calls a `https://example.com/eval-api/` URL, the fixture webhook among them. Then it creates
any missing fixture and resets the rest: each Actor goes back to version 0.0 alone with its fixture
variables, the fixture webhook is created afresh (so an edit to any of its fields is undone), and
the dataset's access goes back to `RESTRICTED`. It deletes on whatever account `APIFY_TOKEN` points
at and prints that account first. Pass `--dry-run` to see what it would delete before it does. No
teardown is needed after a run: a leftover webhook watches an Actor that never runs.

The judge accepts a read through the server's API resource (`ReadMcpResourceTool`) wherever it
accepts `apify-api-read`, since both reach the same URL with the session's token. The `pr` items
do not list it in `expectedTools`: a tool-call item expects the tool that does the job.
`merge/api/webhooks-raw-json-easy` is the one item without `mcpToolsOnly`, so the client's resource
tool is offered next to `apify-api-read`. It passes either way, and its transcript records which
route the agent took. Its Claude Code subprocess inherits the harness's environment, `APIFY_TOKEN`
included, so a Bash `curl` could fetch the true body; the reference fails that route.

Platform behavior the cases are built on (probed YYYY-MM-DD): the published spec has no PATCH
operation, and `/v2/datasets/{datasetId}` has GET, PUT, and DELETE, so a write without a method is
refused there, and `merge/api/dataset-access-method-hard` does not exempt that refusal. `~name`
addresses the token's own Actors and datasets, while a bare name is read as an ID and returns 404.
The legacy `acts/` prefix reaches the same endpoints as `actors/`. `POST /v2/datasets` takes the
name only as the `name` query parameter. Plain environment variable values are returned, secret
ones never are. A 404 from `apify-api-read` lists the closest paths in the spec only when the API
does not have the path (error type `page-not-found`), not when only the record is missing;
`merge/api/env-var-missing-hard` checks that the agent does not blame the path.
`POST /v2/webhooks/{webhookId}/test` sends one delivery to the webhook's URL, which for the fixture
is IANA's reserved example.com. `GET /v2/browser-info` echoes the request headers:
`apify-api-read` masks the token in them, and the resource returns them as they are.

`merge/api/dataset-rename-medium`, `merge/api/webhook-lifecycle-medium`, and
`merge/api/secret-env-var-hard` create fixed names. `merge/api/dataset-access-method-hard` edits a
fixture every trial shares. They are not safe under `--iterations N` above 1 unless you also pass
`--concurrency 1`.
```

Under "Core files", after the schedules fixtures line:

```markdown
- `scripts/api_fixtures.ts` - API-suite fixture CLI entry (`pnpm run evals:mcp-agent:api-fixtures`)
```

In "CI", after the paragraph on the two tiers:

```markdown
The merge tier seeds the task, schedule, and API fixtures before it runs. The API fixtures need no
teardown step.
```

## Follow-ups

- **Run-scoped names for parallel evals (#1423):** when it merges, suffix the names the create cases make with
  `-{{uniq}}` (`eval-api-contacts` and `eval-api-contacts-q4`, the `scratch-failed` URL, and `EVAL_SIGNING_SECRET`),
  upsert the same ids with the edited queries and references, and give `api_fixtures.ts` a matching sweep.
- **The rebuilt cases (#1421):** when they are migrated into the shared datasets, rerun the rebuilt pr cases with `api`
  loaded and watch for steals before `api` joins their tool set. `pr/search-apify-docs/lazy-webhooks-setup` is the
  likeliest.
- **The input validation tool (#1432)** collides with no case here. Once it lands, it is a candidate for another
  routing case.
- **The update-actor tool (#1436)** sets an Actor's default run options and joins the `actors` category every case
  loads. Once it lands, `pr/apify-api-write/default-memory` has a dedicated tool: replace that case with a routing case
  where `update-actor` must win. `get-actor-settings` (#1435) and `update-actor-env-vars` (#1437) overlap the
  environment variable cases the same way.

## Open questions

1. Should a read through the resource satisfy the acceptance criterion of #1443 ("succeed with the API tools")? The merge
   references accept it, and `webhooks-raw-json-easy` measures the choice with the built-ins on. The pr cases do not
   accept it (agreed with the maintainer).
2. Is it fine to keep two private Actors, one webhook, and one dataset on the CI test account for good, and does its plan
   allow two more Actors?
3. Do the README section and the CI step go into #1444 itself, or into an evals PR merged right after it?
4. Promote Batch B the day #1445 merges, or only after Haiku is calibrated on it?
5. Is example.com fine as the webhook URL? Each merge run sends one test delivery there.
6. Should the server instructions stop sending model reads to `resources/read` when `apify-api-read` is loaded (Found
   while drafting, 3)?
7. If probe 11 shows that `POST /v2/webhooks` refuses a name in `condition.actorId`, is that a description gap, fixed by
   saying in the write tool's body guidance that body fields take IDs, or an allowed error on
   `webhook-lifecycle-medium`? An allowed error means `expectedErrors: ["apify-api-write"]`, which would also exempt a
   failed create or delete. Decide before calibrating.
8. If `ReadMcpResourceTool` survives `tools: []`, `ListMcpResourcesTool` may too, and a first call to it scores 0 on
   every pr case. Count it as a lookup, or leave it failing?
9. Should the resource mask the session's token the way `apify-api-read` does (Found while drafting, 5), or keep
   returning every body as it is?
10. Calibrate in two staging datasets of their own, as above, or in #1411's `-v2` staging datasets with an `--id`
    filter on every run?
