# Apify API tool eval cases

Review material for the eval cases of the four opt-in `api` tools: `apify-api-search`, `apify-api-details`,
`apify-api-read` (all three from #1444), and `apify-api-write` (#1445). They sit next to the rebuilt cases of #1421 but
are promoted on their own schedule, in two batches as those two PRs merge, and only once #1423 (run-scoped names) is on
master as well. Delete once they are promoted into the live datasets.

**The cases are uncalibrated.** Nothing here has run against the live Apify API or Langfuse. Expect case fixes during
calibration.

## The files

| File | What |
|---|---|
| `api_tools_pr_cases.json` | 21 `tool-call` cases for `mcp-server-evals-pr`: 11 positive, 10 routing |
| `api_tools_merge_cases.json` | 15 `agent` cases for `mcp-server-evals-merge`: 4 easy, 6 medium, 5 hard. 3 set `expectedErrors` |
| `evals/scripts/api_fixtures.ts` | Seeds the permanent merge fixtures when they are missing, deletes a run's resources with `--run-id`, and sweeps leftovers older than 6 hours (`pnpm run evals:mcp-agent:api-fixtures`) |

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
- The 36 ids are unique and none matches an id in #1421's case files.
- Every tool in `expectedTools` and `expectedErrors` exists on master, #1444 (`5c1a53c8`), or #1445 (`330c8bca`), except
  Claude Code's built-in `ReadMcpResourceTool`. Every `tools` selector is a category on #1445.
- Every name a merge case creates carries `{{uniq}}` in the query and in the reference; the only unmarked names are the
  permanent fixtures'. Resolved as the runner of #1423 (`04ab3138`) resolves it, with a CI run id, each name matches
  its `isNameFromRun`, each dataset name fits the platform's 63 characters of `[a-z0-9-]`, and each static part is 35
  characters or fewer.
- `evals/scripts/api_fixtures.ts` passes type-check, lint, and format on this branch. Its copies of #1423's helpers
  match `evals/run_id.ts` and `evals/scripts/schedules_sweep.ts` there verbatim. It has not run.
- Search ranking, methods per path, and closest-path suggestions were checked by running the server's own
  `searchApiOperations`, `findPathOperations`, and `findClosestApiPaths` on the apify-docs OpenAPI source from
  2026-07-13, not the live spec. The probes below repeat them on the live spec.

## What the cases measure

Routing. A task no dedicated tool does (webhooks, billing usage and limits, an Actor's environment variables, renaming a
dataset) must go to the API tools. A task a dedicated tool does (an Actor's last run, dataset items, starting a build,
creating a schedule) must not.

Every case loads `actors, docs, runs, storage, tasks, schedules, builds, dev, api`. That is #1421's set with `builds`
(for the build routing case) and `api` added, and with `apify/rag-web-browser` and `apify/web-fetch` left out. The
server fetches those two Actors' input schemas at startup, #1421 measured that this races the agent at concurrency 2
and above, and CI runs at the runner default of 8.

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
  same knowledge as the call. The positive cases catch refusing or answering from memory; the 7 that accept a dedicated
  lookup do not catch a first call outside the API family.
- **Lookups on the routing cases.** `api-loaded-build` accepts `fetch-actor-details` and `get-actor-build-list` next
  to `build-actor`, whose `actor` argument needs an ID or `username/name` the query does not give.
- **No `expectedArgs`.** The path is free-form (`webhooks`, `v2/webhooks`, and `/v2/webhooks` are the same), and not
  every accepted tool has a `method` key. The merge references check paths and bodies instead.
- **The resource counts as a read.** Every merge read reference accepts `ReadMcpResourceTool` with the same
  `https://api.apify.com/v2/...` URI, since it reaches the same endpoint with the same token. Every pr case that accepts
  a read lists it too: the server instructions tell the agent to pass any `/v2` GET URL to `resources/read`, and the entry
  costs nothing when `mcpToolsOnly` removes the tool. Two routing cases list it as well: `api-loaded-dataset-items`,
  because the instructions name dataset items, and `api-loaded-run-log`, because the resource templates advertise run
  logs. `webhooks-raw-json-easy` is the one case that measures the choice. This is open for discussion (Open
  questions, 1).
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

## Coverage

"Exercised, not required" means the reference or `expectedTools` accepts the step but passes without it.

| Tool | Argument group or behavior | Cases |
|---|---|---|
| `apify-api-search` | `query`: finds an operation whose path the agent may not know | Exercised, not required: `pr/apify-api-search/resurrect-run`, `pr/apify-api-search/sign-json` (both also accept the direct call), `merge/api/webhook-test-medium`, `merge/api/browser-info-medium` |
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
| | 404 on a missing record, with misleading suggestions | `merge/api/env-var-missing-hard` |
| | Token masking (`/v2/browser-info`) | `merge/api/browser-info-medium` |
| | Resource or tool | `merge/api/webhooks-raw-json-easy`. Every pr case that accepts a read also accepts `ReadMcpResourceTool`. |
| | Response over 256 KB, binary body | Not covered. No endpoint without a dedicated tool returns that much on the eval account reliably. Unit tests cover both. |
| | Routing: a dedicated tool must win | `pr/get-actor-run-list/api-loaded-last-run`, `pr/get-dataset-items/api-loaded-dataset-items`, `pr/get-dataset-list/api-loaded-dataset-list`, `pr/get-actor-run-log/api-loaded-run-log` |
| `apify-api-write` | POST with `body` | `pr/apify-api-write/alert-on-crash`, `secret-env-var`, `merge/api/webhook-lifecycle-medium`, `merge/api/secret-env-var-hard` |
| | POST with `query` | `merge/api/dataset-rename-medium`, `dataset-access-method-hard` (`name` query parameter) |
| | POST with neither | `merge/api/webhook-test-medium` |
| | PUT with `body` | `pr/apify-api-write/rename-dataset`, `merge/api/dataset-rename-medium`, `merge/api/dataset-access-method-hard`. `merge/api/secret-env-var-hard` fails a version PUT, which replaces every variable on the version. |
| | DELETE | `merge/api/webhook-lifecycle-medium`, `dataset-rename-medium`, `secret-env-var-hard`, `dataset-access-method-hard` |
| | `method` omitted, several methods (refused) | Not covered; unit tests cover it. `merge/api/dataset-access-method-hard` does not exempt it: the method parameter says to omit the method only when the path has one, so the error gate fails a write without a method there. |
| | `method` omitted, one method (inferred) | Exercised, not pinned: `merge/api/webhook-test-medium` (`/test` has only POST) |
| | `method` omitted on a GET-only path (refused, names the read tool) | Not covered. Unit tests cover it. |
| | PATCH | Not covered. The July spec has no PATCH operation; probe 1 checks the live spec. |
| | Write whose response is over 256 KB | Not covered. Unit tests cover it. |
| | Secret semantics (`isSecret`) | `pr/apify-api-write/secret-env-var`, `merge/api/secret-env-var-hard` |
| | Change only what was asked | `merge/api/secret-env-var-hard` (only its own variable: no version PUT, and EVAL_MODE survives), `merge/api/dataset-access-method-hard` (no rename) |
| | Routing: a dedicated tool must win | `pr/build-actor/api-loaded-build`, `pr/call-actor/api-loaded-run-actor`, `pr/create-schedule/api-loaded-schedule`, `pr/update-actor-task/api-loaded-task-input` |

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

## Running in parallel

CI runs 8 items at once on one shared account, and several PRs can run at once, so a fixed name collides and a reset
can change a fixture under another run. The merge cases follow #1423's model:

- **Run-scoped:** every name a case creates ends in `-{{uniq}}`, in the query and in the reference. #1423's runner
  replaces the marker with `<runId>-t<trial>` before the agent and the judge see the item. Four cases create
  something, and each deletes it again:
  - `dataset-rename-medium`: the dataset `eval-api-contacts-{{uniq}}`, renamed to `eval-api-contacts-q4-{{uniq}}`.
  - `dataset-access-method-hard`: the dataset `eval-api-shared-{{uniq}}`, opened to anyone with the link.
  - `webhook-lifecycle-medium`: a webhook on `eval-api-actor-scratch` that calls
    `https://example.com/eval-api/scratch-failed-{{uniq}}`.
  - `secret-env-var-hard`: the variable `EVAL_SIGNING_SECRET-{{uniq}}` on version 0.0 of `eval-api-actor-scratch`. A
    PUT of the whole version would replace another run's variable, so the query says other jobs edit that Actor's
    variables, and the reference fails a version PUT. An env var name takes any character except `=`, up to 100.
- **Read-only:** the other 11 cases create no named resource and read the permanent fixtures, unmarked.
  `webhook-test-medium` sends a test delivery to the fixture webhook, which adds a dispatch but changes nothing a case
  asserts on.
- **Teardown:** `api_fixtures.ts --run-id <id>` deletes that run's datasets, webhooks, and variables at any age, by the
  token `-<id>-t` that #1423's `isNameFromRun` matches. Anything else goes only once it is older than 6 hours, so a run
  in flight never loses a resource it is using.

The cases need #1423's runner. Without it, `{{uniq}}` reaches the agent as typed: a dataset create fails on the
braces, and every trial shares one webhook URL and one variable name. With it, `--iterations` above 1 is safe too.

One collision is left. When two variable writes land on one Actor at the same moment, the platform rejects one of
them with a concurrent update error. `secret-env-var-hard` in two runs, or the case and another run's teardown, can
meet this way on `eval-api-actor-scratch`, but only within milliseconds of each other.

## Fixtures

`api_fixtures.ts` seeds two permanent fixtures when they are missing. No case may modify them, and the script never
resets or deletes them, since another run may be reading them:

- `eval-api-actor`, read-only: version 0.0 alone, with `EVAL_REGION=eu-central-1` (plain) and `EVAL_API_KEY` (secret),
  plus one webhook that calls `https://example.com/eval-api/run-failed` when a run fails. The read cases assert on it.
- `eval-api-actor-scratch`, the write target: version 0.0 alone, with `EVAL_MODE=scratch` (plain). The write cases add
  their own webhook and variable to it and remove them again; `EVAL_MODE` must survive.

The two Actors are separate so that a variable a write case adds never shows up in a read case's answer. Neither is
ever built or run, so the fixture webhook never fires on its own and nothing costs compute.

A missing fixture is created, and so is a missing part of one: version 0.0, a fixture variable, or the fixture
webhook. A fixture that has drifted, for example with a changed variable or an extra version, only gets a warning to
fix it by hand while no run is in flight.

What the script deletes, on whatever account `APIFY_TOKEN` points at. It prints that account first, and `--dry-run`
shows what it would delete:

| Resource | With `--run-id <id>`, at any age | Otherwise, once older than 6 hours |
|---|---|---|
| Datasets the account owns | `eval-api-*` names that contain `-<id>-t` | any other `eval-api-*` dataset, since none is a fixture |
| Webhooks | URLs under `https://example.com/eval-api/` that contain `-<id>-t` | any other webhook under that URL or on a fixture Actor, except the fixture webhook |
| Variables on version 0.0 of both fixture Actors | names that contain `-<id>-t` | any other variable that is not a fixture variable |

A variable has no timestamp of its own, but every variable write updates the Actor's `modifiedAt` (probe 22), so the
script ages variables by the Actor's `modifiedAt`, read after the variable list.

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

5. `~name` resolves the token's own resources: `GET /v2/actors/~eval-api-actor` and, for a dataset the probe creates,
   `GET /v2/datasets/~eval-api-named-probe-t1` return 200. So does `username~name`:
   `GET /v2/datasets/{username}~eval-api-named-probe-t1` returns 200.
6. The account can create private Actors with a `SOURCE_FILES` version and `envVars` (including `isSecret: true`)
   without a build, and its plan allows two more Actors.
7. `GET .../versions/0.0/env-vars` returns the plain value of EVAL_REGION and no value for EVAL_API_KEY. The version and
   Actor objects carry `envVars` the same way.
8. `GET .../env-vars/EVAL_TIMEZONE` returns 404, and so does `GET /v2/users/me/usage`. Record both error types.
9. `POST /v2/datasets` reads the name only from the `name` query parameter, so a body-only `name` creates an unnamed
   dataset. A second POST with an existing name returns the existing dataset. Renaming onto a taken name fails; record
   the error type.
10. A dataset created with `POST /v2/datasets` starts `RESTRICTED`. If the account's default access is wider,
    `dataset-access-method-hard` has nothing to change: set the account default to restricted, or rework the case.
    `PUT /v2/datasets/{id}` with only `generalAccess: ANYONE_WITH_ID_CAN_READ` works on the account's plan and keeps
    the name.
11. `POST /v2/webhooks` needs `condition.actorId` to be an ID. If it also takes `~eval-api-actor-scratch` or
    `username~name`, widen `webhook-lifecycle-medium`; if it refuses a name, settle Open questions, 7 before
    calibrating. `description` is stored, and the list returns it and `condition`.
12. `POST /v2/webhooks/{id}/test` returns a dispatch (record its status), sends one POST to the example.com URL, and
    works for a webhook whose Actor never ran.
13. `GET /v2/webhook-dispatches?limit=3&desc=1` honors both parameters.
14. `POST .../env-vars` with `isSecret: true` returns `isSecret: true` and no value, and DELETE removes it, for a name
    with dashes like the run-scoped `EVAL_SIGNING_SECRET-<runId>-t1`. If `PUT .../env-vars/{name}` on a missing name
    creates it, add that PUT to the create routes in `secret-env-var-hard`.
15. `GET /v2/users/me/limits` has `limits.maxMonthlyUsageUsd` and `current.monthlyUsageUsd`, the spend of the current
    period. `GET /v2/users/me/usage/monthly` has a USD total and the cycle dates. The references do not assume the two
    totals are equal.
16. `GET /v2/browser-info` echoes the `Authorization` header raw. Print only whether the body contains the token, never
    the token. Unit tests cover the masking in `apify-api-read`. The resource returns the body as it is (Found while
    drafting, 5).
17. A bare name without `~` is read as an ID: `GET /v2/actors/eval-api-actor` and
    `GET /v2/datasets/eval-api-named-probe-t1` return 404. The legacy `acts/` prefix reaches the same endpoint as
    `actors/`.
18. The webhook list returns `requestUrl` and `lastDispatch`. Record what `lastDispatch` holds:
    `webhook-deliveries-medium` says it is at most one delivery per webhook.
19. The items of `GET /v2/webhook-dispatches` include `calls[].responseStatus`. If not,
    `GET /v2/webhook-dispatches/{id}` does; record which.
20. `GET /v2/users/me` has the plan's included monthly usage in USD. If not, drop `/v2/users/me` from
    `budget-vague-hard`.
21. `PUT /v2/actors/{actorId}/versions/0.0` with only `envVars` replaces the version's whole variable list and keeps its
    source files. That is why `secret-env-var-hard` fails a version PUT.
22. Adding a variable and deleting one each update the Actor's `modifiedAt`. `api_fixtures.ts` ages variables by it,
    since a variable has no timestamp. If not, drop the age sweep of variables and delete them by `--run-id` alone.

Harness:

23. Does `tools: []`, which `mcpToolsOnly` sets, remove Claude Code's `ReadMcpResourceTool`? Check the first staging
    run's transcripts. No case depends on the answer, but it decides whether `webhooks-raw-json-easy` is the only case
    that can show the resource route (Open questions, 8).
24. A refusal from `respondUserError` (method missing, path not in the spec) reaches the gate as a failed tool call.
    `old-path-404-hard` and `dataset-access-method-hard` assume it does.

<details><summary>Throwaway probe script</summary>

Write it as `evals/scripts/probe_api_tmp.ts` in a checkout of #1445's branch, run it with `APIFY_TOKEN` set, and delete
it. Every name it creates is run-scoped to the run id `probe`, so
`pnpm run evals:mcp-agent:api-fixtures -- --run-id probe` on this branch deletes whatever it left. Run it while no
calibration run is in flight: its version PUTs replace the variables of `eval-api-actor-scratch`. Every print goes
through `redact()`, since `GET /v2/browser-info` echoes the token, and `users/me` prints no body, since it holds the
proxy password.

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

// Platform facts 5-22.
const me = await call('GET', 'users/me', undefined, { preview: false });
const actor = await call('GET', 'actors/~eval-api-actor');
show('Actor versions', actor.data?.versions?.map((v: any) => ({ versionNumber: v.versionNumber, envVars: v.envVars })));
await call('GET', 'acts/~eval-api-actor');
await call('GET', 'actors/eval-api-actor');
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

const bodyOnly = await call('POST', 'datasets', { name: 'eval-api-body-probe-t1' });
const named = await call('POST', 'datasets?name=eval-api-named-probe-t1');
show('new dataset generalAccess', named.data?.generalAccess);
await call('POST', 'datasets?name=eval-api-named-probe-t1');
await call('GET', 'datasets/~eval-api-named-probe-t1');
await call('GET', `datasets/${me.data?.username}~eval-api-named-probe-t1`);
await call('GET', 'datasets/eval-api-named-probe-t1');
const other = await call('POST', 'datasets?name=eval-api-other-probe-t1');
await call('PUT', `datasets/${other.data.id}`, { name: 'eval-api-named-probe-t1' });
await call('PUT', `datasets/${named.data.id}`, { generalAccess: 'ANYONE_WITH_ID_CAN_READ' });
await call('DELETE', `datasets/${named.data.id}`);
await call('DELETE', `datasets/${other.data.id}`);
await call('DELETE', `datasets/${bodyOnly.data.id}`);

const scratch = await call('GET', 'actors/~eval-api-actor-scratch');
const hook = { eventTypes: ['ACTOR.RUN.FAILED'], requestUrl: 'https://example.com/eval-api/hook-probe-t1', description: 'probe' };
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
const modifiedAt = async () => (await call('GET', `actors/${scratch.data.id}`, undefined, { preview: false })).data?.modifiedAt;
show('scratch modifiedAt before', scratch.data?.modifiedAt);
await call('POST', envVars, { name: 'EVAL_SECRET-probe-t1', value: 'probe', isSecret: true });
show('scratch modifiedAt after the add', await modifiedAt());
await call('GET', envVars);
await call('PUT', `${envVars}/EVAL_MISSING-probe-t1`, { name: 'EVAL_MISSING-probe-t1', value: 'probe' });
await call('DELETE', `${envVars}/EVAL_SECRET-probe-t1`);
show('scratch modifiedAt after the delete', await modifiedAt());
await call('DELETE', `${envVars}/EVAL_MISSING-probe-t1`);

const scratchVersion = `actors/${scratch.data.id}/versions/0.0`;
const mode = { name: 'EVAL_MODE', value: 'scratch', isSecret: false };
const secret = { name: 'EVAL_SECRET-probe-t1', value: 'probe', isSecret: true };
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
2. **Closest-path suggestions mislead on a missing record.** Every 404 from the call tools lists "the closest paths in
   the API spec", even when the path is right and only the record is missing, and for a missing env var the list starts
   with `/v2/actors`, ahead of the env-var template the path matches. Possible fixes: suggest only when the path matches
   no template, and rank a matching template first. `env-var-missing-hard` measures whether agents misread it.
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

- **pr tier:** 7 of the 11 positive cases also accept a first call to a tool already on master (`fetch-actor-details`,
  `get-dataset`, `get-dataset-list`, `get-actor-run`, or the docs tools), and the 10 routing cases pass trivially. The
  tier would likely stay above its 0.9 gate while measuring nothing about the API tools: against today's live pr dataset
  (111 of 115 passing on a hosted run), 2 of those 7 passing give 123 of 136, a rate of 0.904. Only
  `webhooks-on-account`, `spend-this-billing-cycle`, `monthly-spending-cap`, and `sign-json` would fail.
- **merge tier:** most of the 15 cases fail. The tier stays above its 0.6 gate, but real regressions would hide behind
  expected failures, and the write cases would run without fixtures.

Accepting `ReadMcpResourceTool` adds to the risk: the resource is on master already, so if `mcpToolsOnly` does not
remove it (probe 23), the three read cases among those four could pass before #1444 through the resource too, which
would hide the missing `api` category.

Langfuse item ids are unique per project forever and cannot move between datasets, so the cases are calibrated in
staging datasets under burned ids and promoted under the final ids:

1. Create `mcp-server-evals-pr-api-staging` and `mcp-server-evals-merge-api-staging`, and upsert every case there with
   its id prefixed `stage-api/`.
2. Calibrate from a local merge of #1445's branch, which contains #1444, and #1423's branch, whose runner resolves
   `{{uniq}}`: Opus first, then Sonnet and Haiku, at `--concurrency 1`, reading every transcript. Run the merge waves in
   order (easy, medium, hard), each with its own `--run-id`, and tear each one down with that id. Fix cases until Opus
   passes them all.
3. Add the README section and the CI steps below with #1444, or in an evals PR merged right after it.
4. **Batch A, after #1444 and #1423 are both on master** and the fixtures have run once on the CI account: the 12 pr
   cases and 10 merge cases that need only search, details, and read. That is every case except the ones in Batch B.
   If pinned dataset versions (#1395) have landed by then, promotion is the upsert plus a pin bump in whichever of the
   two merges last, so the cases go live exactly when both are in; otherwise the upsert follows the later merge.
5. **Batch B, after #1445 is on master** (and #1423, as for Batch A): the 9 write-dependent pr cases and the merge cases
   `webhook-lifecycle-medium`, `dataset-rename-medium`, `webhook-test-medium`, `secret-env-var-hard`, and
   `dataset-access-method-hard`. The 9 pr cases are the three `pr/apify-api-write/*` cases, `resurrect-run` and
   `sign-json` (which ask for writes), and the four routing cases where `apify-api-write` must lose: `api-loaded-build`,
   `api-loaded-run-actor`, `api-loaded-schedule`, and `api-loaded-task-input`.
6. Archive the staging items and abandon the two staging datasets.

Nothing goes live before #1423 is on master. The four cases that create names are all in Batch B, and only #1423's
runner resolves their `{{uniq}}`. Batch A creates nothing and would run without it, but waits as well, so that the
fixtures' CI steps land once, in their final form.

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
C="$PWD"   # this branch's checkout, with a .env like the calibration checkout's
R="$C/res/eval_cases_review"
W=/path/to/a/second/checkout   # becomes the calibration branch below
B_PR='^pr/(apify-api-write/(rename-dataset|alert-on-crash|secret-env-var)|apify-api-search/(resurrect-run|sign-json)'
B_PR+='|build-actor/api-loaded-build|call-actor/api-loaded-run-actor|create-schedule/api-loaded-schedule'
B_PR+='|update-actor-task/api-loaded-task-input)$'
B_MERGE='^merge/api/(webhook-lifecycle-medium|dataset-rename-medium|webhook-test-medium|secret-env-var-hard|dataset-access-method-hard)$'
to_items() { jq -c --arg ds "$1" '.[] | {datasetName: $ds, id, input: {query}}
    + (if has("reference") then {expectedOutput: .reference} else {} end)
    + {metadata: del(.id, .query, .reference)}' "$2"; }
upsert() { while IFS= read -r item; do printf '%s' "$item" | npx -y langfuse-cli api dataset-items create --body-file -; done; }
fixtures() { (cd "$C" && pnpm run evals:mcp-agent:api-fixtures -- "$@"); }

# The calibration branch: #1445, which contains #1444, with #1423 merged in so the runner resolves {{uniq}}.
git -C "$W" fetch origin feat/apify-api-write claude/kind-lovelace-4sxlmg
git -C "$W" switch -c calibrate/api-tool-evals origin/feat/apify-api-write
git -C "$W" merge --no-edit origin/claude/kind-lovelace-4sxlmg

# Fixtures. Safe to repeat: the seed creates what is missing and resets nothing.
fixtures --dry-run && fixtures

# Staging datasets and items. Create is an upsert on id, so re-run after any edit.
cd /tmp && export $(grep -E '^LANGFUSE' "$W/.env" | xargs) && export LANGFUSE_HOST="$LANGFUSE_BASE_URL"
for name in mcp-server-evals-pr-api-staging mcp-server-evals-merge-api-staging; do
    printf '{"name":"%s","description":"Staging for the Apify API tool evals. Ids here are burned."}' "$name" \
        | npx -y langfuse-cli api datasets create --body-file -
done
to_items mcp-server-evals-pr-api-staging "$R/api_tools_pr_cases.json" | jq -c '.id = "stage-api/" + .id' | upsert
to_items mcp-server-evals-merge-api-staging "$R/api_tools_merge_cases.json" | jq -c '.id = "stage-api/" + .id' | upsert

# Calibrate, on the calibration branch. Repeat with claude-sonnet-5 and claude-haiku-4-5 once Opus passes.
cd "$W"
pnpm run evals:mcp-agent -- --dataset mcp-server-evals-pr-api-staging \
    --agent-model claude-opus-5 --subscription --claude-judge --concurrency 1
RUN="cal-$(date +%s)"   # a fresh id per merge run: lowercase letters, digits, and dashes
pnpm run evals:mcp-agent -- --dataset mcp-server-evals-merge-api-staging --id 'easy$' \
    --agent-model claude-opus-5 --subscription --claude-judge --concurrency 1 --run-id "$RUN"
fixtures --run-id "$RUN"   # the teardown; then the same for 'medium$' and 'hard$'

# Promote Batch A, then Batch B (drop the "| not" from both selects).
cd /tmp
to_items mcp-server-evals-pr "$R/api_tools_pr_cases.json" | jq -c --arg b "$B_PR" 'select(.id | test($b) | not)' | upsert
to_items mcp-server-evals-merge "$R/api_tools_merge_cases.json" | jq -c --arg b "$B_MERGE" 'select(.id | test($b) | not)' | upsert

# Archive the staging items.
to_items mcp-server-evals-pr-api-staging "$R/api_tools_pr_cases.json" \
    | jq -c '.id = "stage-api/" + .id | .status = "ARCHIVED"' | upsert
to_items mcp-server-evals-merge-api-staging "$R/api_tools_merge_cases.json" \
    | jq -c '.id = "stage-api/" + .id | .status = "ARCHIVED"' | upsert
```

A Claude judge scoring a Claude agent can be lenient on itself. Before quoting final numbers, run one merge pass without
`--claude-judge`, which uses OpenRouter.

Turn budgets: easy cases get 8 (one read, or a lookup then a read). Medium cases get 10 to 12 for read chains and 14 for
create, verify, and clean up; `webhook-deliveries-medium` budgets the per-webhook route. Hard cases get 10, budgeted
for the recovery path, or 14 for `secret-env-var-hard` and `dataset-access-method-hard`, which also create, verify, and
clean up.

## Proposed text for promotion

Not part of this PR. Add with #1444, or in the evals PR right after it, once #1423 is on master: the README text
points at its "Unique resource names" section, and the teardown matches the run id #1423 passes to the run step.

The CI steps, in `.github/workflows/_evaluations.yaml`. The seed goes after "Seed schedule fixtures":

```yaml
            -   name: Seed API fixtures (merge tier only)
                if: inputs.tier == 'merge'
                run: pnpm run evals:mcp-agent:api-fixtures
                env:
                    APIFY_TOKEN: ${{ secrets.APIFY_TOKEN }}
```

The teardown goes after "Tear down schedule fixtures":

```yaml
            # Same run id as the run step, so this deletes only what this run created; `always()` so a
            # failed or cancelled run still cleans up.
            -   name: Tear down API fixtures (merge tier only)
                if: always() && inputs.tier == 'merge'
                run: >
                    pnpm run evals:mcp-agent:api-fixtures --
                    --run-id ${{ github.run_id }}-${{ github.run_attempt }}
                env:
                    APIFY_TOKEN: ${{ secrets.APIFY_TOKEN }}
```

For `evals/README.md`, after the web-selection family paragraph in "Two datasets: kind, id scheme, and expectedErrors"
(or with the other family paragraphs, if #1421's migration has rewritten that section by then). Replace the probe date
and correct any fact the probes disprove:

```markdown
The API family (21 `pr` items: 11 `pr/apify-api-*/*` and 10 routing items `pr/*/api-loaded-*` in
category `apify-api-routing`; and `merge/api/*`, 15 items: 12 proper + 3 with `expectedErrors`)
covers the opt-in `api` tools: `apify-api-search`, `apify-api-details`, `apify-api-read`, and
`apify-api-write`. A routing item's id names the dedicated tool that must win, as the rest of the
`pr` ids name the tool they assert. Every item loads the same wide tool set,
`actors,docs,runs,storage,tasks,schedules,builds,dev,api`, and all but one set `mcpToolsOnly: true`.
The two default Actor tools are left out: the server fetches their input schemas at startup, which
races the agent at CI's concurrency. The set is wide because what the family measures is routing: a
task no dedicated tool does (webhooks, billing usage and limits, an Actor's environment variables,
renaming a dataset) must go to the API tools, and a task a dedicated tool does (an Actor's last run,
dataset items, starting a build, creating a schedule) must not. The positive `pr` items accept an
API lookup (`apify-api-search` or `apify-api-details`), the API call that does the task, or an API
read before a write as the first call, since the read and write descriptions tell the agent to look
an operation up first. Seven also accept a dedicated lookup (`fetch-actor-details` where the query
names an Actor without its username, `get-dataset`, `get-dataset-list`, `get-actor-run`, or the docs
tools), so they do not catch a first call outside the API family. Even `resurrect-run` and
`sign-json` accept the direct call, so no item requires `apify-api-search` or `apify-api-details`.
The `expectedErrors` exemption is per tool, not per call, which leaves a known blind spot: on
`merge/api/old-path-404-hard` it also covers a failure of the follow-up read of
`/v2/users/me/usage/monthly`, and its reference narrows that by failing an answer that says the read
failed and still gives a total. On `merge/api/env-var-missing-hard`, a read that 404s on a wrong
`username~` prefix looks like a missing variable to the judge.

The `merge/api/*` items name what they create with `{{uniq}}` (see "Unique resource names" below),
so their trials and any concurrent run never share a resource, and `--iterations N` is safe. Four
items create something and delete it again: the datasets `eval-api-contacts-{{uniq}}` (renamed to
`eval-api-contacts-q4-{{uniq}}`) and `eval-api-shared-{{uniq}}`, a webhook that calls
`https://example.com/eval-api/scratch-failed-{{uniq}}`, and the secret variable
`EVAL_SIGNING_SECRET-{{uniq}}`. The rest read two permanent fixtures, which no item may modify. The
Actor `eval-api-actor` has only version 0.0, with `EVAL_REGION=eu-central-1` and the secret
`EVAL_API_KEY`, plus one webhook that calls `https://example.com/eval-api/run-failed` when a run
fails; the read items assert on it. The Actor `eval-api-actor-scratch` has only version 0.0, with
`EVAL_MODE=scratch`; the write items add their own webhook and variable to it and remove them again.
`merge/api/secret-env-var-hard` fails a PUT of the whole version, since that replaces every variable
on it, another run's among them. Neither Actor is ever built or run, so the fixture webhook never
fires on its own.

Run `pnpm run evals:mcp-agent:api-fixtures` before a run: it creates any missing fixture, never
resets one, and deletes `eval-api-*` datasets, eval webhooks, and stray variables on the fixture
Actors once they are older than 6 hours, on whatever account `APIFY_TOKEN` points at. Pass
`--dry-run` to see what it would delete. After a run, delete what that run created with
`pnpm run evals:mcp-agent:api-fixtures -- --run-id <id>`, using the run id from the run's summary.
CI does this in a `Tear down API fixtures` step guarded by `always()`.

The judge accepts a read through the server's API resource (`ReadMcpResourceTool`) wherever it
accepts `apify-api-read`, since both reach the same URL with the session's token. The `pr` items
that accept a read list `ReadMcpResourceTool` in `expectedTools` for the same reason, as do
`pr/get-dataset-items/api-loaded-dataset-items` and `pr/get-actor-run-log/api-loaded-run-log`, where
the server's instructions and resource templates point at the resource; the entry costs nothing if
`mcpToolsOnly` removes the tool.
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
ones never are. A 404 from `apify-api-read` lists the closest paths in the spec even when the path is
right and only the record is missing, which `merge/api/env-var-missing-hard` checks the agent does
not misread. `POST /v2/webhooks/{webhookId}/test` sends one delivery to the webhook's URL, which
for the fixture is IANA's reserved example.com. `GET /v2/browser-info` echoes the request headers:
`apify-api-read` masks the token in them, and the resource returns them as they are. A new dataset
starts `RESTRICTED`. A PUT of an Actor version replaces its whole variable list, and every variable
write updates the Actor's `modifiedAt`, which the fixtures script ages variables by.
```

Under "Core files", after the schedules fixtures line:

```markdown
- `scripts/api_fixtures.ts` - API-suite fixture CLI entry (`pnpm run evals:mcp-agent:api-fixtures`)
```

In "CI", after the paragraph on the two tiers:

```markdown
The merge tier seeds the task, schedule, and API fixtures before it runs. After it, two steps
guarded by `always()` delete the schedules and the API resources that run created, matched by its
run id.
```

## Follow-ups

- **Once #1423 merges:** import `isNameFromRun`, `parseRunIdArg`, and `LEFTOVER_MAX_AGE_MS` in `api_fixtures.ts` from
  `evals/run_id.ts` and `evals/scripts/schedules_sweep.ts` (the `TODO(#1423)` there). The runner's teardown hint names
  only the schedules command, so add the API one next to it.
- **The rebuilt cases (#1421):** when they are migrated into the shared datasets, rerun the rebuilt pr cases with `api`
  loaded and watch for steals before `api` joins their tool set. `pr/search-apify-docs/lazy-webhooks-setup` is the
  likeliest.
- **The input validation tool (#1432)** collides with no case here. Once it lands, it is a candidate for another
  routing case.

## Open questions

1. Should a read through the resource satisfy the acceptance criterion of #1443 ("succeed with the API tools")? The cases
   say yes: the merge references accept it, the pr cases that accept a read list it, and `webhooks-raw-json-easy`
   measures the choice with the built-ins on.
2. Is it fine to keep two private Actors and one webhook on the CI test account for good, and does its plan allow two
   more Actors?
3. Do the README section and the CI steps go into #1444 itself, or into an evals PR merged right after it?
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
