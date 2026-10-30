# Eval case review: every new case, and every v1 case not carried over

Review aid for the migration in #1411. Delete once the cases land in
`mcp-server-evals-pr` / `mcp-server-evals-merge` and the `-v2` staging datasets are abandoned.

Generated from the live v1 snapshots and the authored v2 case files. Not hand-edited.

## At a glance

| | v1 | new | 
|---|---|---|
| PR tier (`tool-call`) | 125 | 74 |
| merge tier (`agent`) | 70 | 37 |

Every new case carries the same two settings, so they are omitted from the per-case entries below:

```
tools:        [actors, docs, runs, storage, tasks, schedules, dev,
               apify/rag-web-browser, apify/web-fetch]   # all 29 in-scope tools
mcpToolsOnly: true                                       # no client built-ins
```

Anything else on a case (`expectedArgs`, `expectedErrors`, `failTools`, `maxTurns`) is shown.

---

## PR tier — 74 `tool-call` cases

`WANT` is `expectedTools`. Where two tools are listed, the second is a defensible sibling read
the scorer also accepts — see #1411 for why. `ARGS` is `expectedArgs`: every listed key must
deep-equal the captured call's same key; unlisted keys are ignored.

### `abort-actor-run`

**`pr/abort-actor-run/graceful-stop`**

> stop run oQNzVLE4B1CcjtzhS but let it save what it already has

- WANT `abort-actor-run` or `get-actor-run`

**`pr/abort-actor-run/lazy-kill-it`**

> kill run oQNzVLE4B1CcjtzhS, its burning credits

- WANT `abort-actor-run` or `get-actor-run`

### `apify--rag-web-browser`

**`pr/rag-web-browser/few-articles-by-topic`**

> find me a few articles about prague public transport strikes

- WANT `apify--rag-web-browser`

**`pr/rag-web-browser/lazy-latest-ai-chip-rules`**

> whats the latest on ai chip export rules

- WANT `apify--rag-web-browser`

**`pr/rag-web-browser/search-not-discovery-not-fetch`**

> whats being said online about apify pricing lately

- WANT `apify--rag-web-browser`

### `apify--web-fetch`

**`pr/web-fetch/blocked-page-retry`**

> i keep getting 403 trying to read https://www.reddit.com/r/webscraping/ - can you get it for me

- WANT `apify--web-fetch`

**`pr/web-fetch/lazy-single-url-content`**

> whats on https://www.rfc-editor.org/rfc/rfc9110.html

- WANT `apify--web-fetch`

**`pr/web-fetch/links-on-page`**

> list the links on https://docs.apify.com/platform

- WANT `apify--web-fetch`

### `call-actor`

**`pr/call-actor/budget-cap-one-dollar`**

> run apify/google-search-scraper for 'prague coffee' but dont let it cost more than $1

- WANT `call-actor` or `fetch-actor-details`

**`pr/call-actor/lazy-just-run-hello`**

> just run apify/hello-world

- WANT `call-actor` or `fetch-actor-details`

**`pr/call-actor/memory-cap-512`**

> run apify/hello-world, cap the memory at 512 MB

- WANT `call-actor` or `fetch-actor-details`

**`pr/call-actor/wait-two-minutes`**

> run apify/hello-world and wait up to 2 minutes for it to finish

- WANT `call-actor` or `fetch-actor-details`

### `create-actor-task`

**`pr/create-actor-task/lazy-save-config`**

> save apify/hello-world as something i can rerun, call it eval-hello-rerun

- WANT `create-actor-task` or `fetch-actor-details`

**`pr/create-actor-task/not-a-schedule-trap`**

> i want to keep this apify/hello-world setup so i dont have to retype it every time, name it eval-hello-keep

- WANT `create-actor-task`

**`pr/create-actor-task/with-stored-input`**

> make a reusable config for apify/normal-mode-test-actor that adds 5 and 7, name it eval-sum-five-seven

- WANT `create-actor-task` or `fetch-actor-details`

### `create-schedule`

**`pr/create-schedule/created-paused`**

> set up apify/hello-world to run mondays at 8 but leave it switched off for now, name it eval-sched-mon

- WANT `create-schedule` or `fetch-actor-details`

**`pr/create-schedule/explicit-cron`**

> schedule my task eval-sum-nightly on the cron 0 3 * * * , name it eval-sched-cron

- WANT `create-schedule` or `get-actor-task`

**`pr/create-schedule/lazy-every-morning`**

> run my task eval-sum-nightly every morning at 7

- WANT `create-schedule` or `get-actor-task`

**`pr/create-schedule/timezone-prague`**

> kick off eval-sum-nightly at 6am prague time every day

- WANT `create-schedule` or `get-actor-task`

### `delete-schedule`

**`pr/delete-schedule/lazy-get-rid-of-it`**

> get rid of the eval-nightly-sum schedule

- WANT `delete-schedule` or `get-schedule`

**`pr/delete-schedule/remove-completely-not-pause`**

> i dont need eval-nightly-sum anymore, remove it completely

- WANT `delete-schedule` or `get-schedule`

### `fetch-actor-details`

**`pr/fetch-actor-details/lazy-cost-tweet-scraper`**

> how much do i pay for apidojo/tweet-scraper

- WANT `fetch-actor-details`
- ARGS `{"actor": "apidojo/tweet-scraper"}`

**`pr/fetch-actor-details/lazy-what-input-needed`**

> what do i have to fill in to run apify/google-search-scraper

- WANT `fetch-actor-details`
- ARGS `{"actor": "apify/google-search-scraper"}`

**`pr/fetch-actor-details/lazy-whats-it-about`**

> whats apify/instagram-scraper about

- WANT `fetch-actor-details`
- ARGS `{"actor": "apify/instagram-scraper"}`

### `fetch-apify-docs`

**`pr/fetch-apify-docs/explicit-url-page`**

> read https://docs.apify.com/platform/actors/running/input-and-output and summarise it for me

- WANT `fetch-apify-docs`
- ARGS `{"url": "https://docs.apify.com/platform/actors/running/input-and-output"}`

**`pr/fetch-apify-docs/missing-page`**

> open https://docs.apify.com/platform/this-page-does-not-exist for me

- WANT `fetch-apify-docs` or `apify--web-fetch`

### `get-actor-run`

**`pr/get-actor-run/lazy-is-it-done`**

> is run oQNzVLE4B1CcjtzhS done yet

- WANT `get-actor-run`
- ARGS `{"runId": "oQNzVLE4B1CcjtzhS"}`

**`pr/get-actor-run/wait-until-finished`**

> wait up to 60 seconds for run oQNzVLE4B1CcjtzhS to finish and tell me how it went

- WANT `get-actor-run`
- ARGS `{"runId": "oQNzVLE4B1CcjtzhS", "waitSecs": 60}`

### `get-actor-run-list`

**`pr/get-actor-run-list/lazy-what-ran-lately`**

> what have i run lately

- WANT `get-actor-run-list`

**`pr/get-actor-run-list/only-failed-ones`**

> show me my failed runs

- WANT `get-actor-run-list`
- ARGS `{"status": "FAILED"}`

### `get-actor-run-log`

**`pr/get-actor-run-log/error-message-not-status`**

> whats the actual error message in run oQNzVLE4B1CcjtzhS

- WANT `get-actor-run-log` or `get-actor-run`

**`pr/get-actor-run-log/last-50-lines`**

> show me the last 50 log lines of run oQNzVLE4B1CcjtzhS

- WANT `get-actor-run-log`
- ARGS `{"lines": 50, "runId": "oQNzVLE4B1CcjtzhS"}`

**`pr/get-actor-run-log/lazy-why-did-it-break`**

> run oQNzVLE4B1CcjtzhS blew up, why

- WANT `get-actor-run-log` or `get-actor-run`

### `get-actor-task`

**`pr/get-actor-task/is-it-public`**

> is eval-sum-nightly public

- WANT `get-actor-task`

**`pr/get-actor-task/lazy-what-does-it-run`**

> what does my task eval-sum-nightly actually run

- WANT `get-actor-task`
- ARGS `{"taskId": "eval-sum-nightly"}`

### `get-dataset`

**`pr/get-dataset/lazy-how-many-rows`**

> how many rows are in dataset iSpp2Q3G60uWDLOi0

- WANT `get-dataset`
- ARGS `{"datasetId": "iSpp2Q3G60uWDLOi0"}`

**`pr/get-dataset/when-created`**

> when was dataset iSpp2Q3G60uWDLOi0 created

- WANT `get-dataset`

### `get-dataset-items`

**`pr/get-dataset-items/lazy-show-data`**

> show me whats in dataset iSpp2Q3G60uWDLOi0

- WANT `get-dataset-items` or `get-dataset`

**`pr/get-dataset-items/newest-first`**

> last 10 entries of dataset iSpp2Q3G60uWDLOi0, newest first

- WANT `get-dataset-items`
- ARGS `{"datasetId": "iSpp2Q3G60uWDLOi0", "desc": true, "limit": 10}`

**`pr/get-dataset-items/only-two-fields`**

> from dataset iSpp2Q3G60uWDLOi0 i only need title and url

- WANT `get-dataset-items`
- ARGS `{"datasetId": "iSpp2Q3G60uWDLOi0", "fields": "title,url"}`

**`pr/get-dataset-items/page-two`**

> give me rows 100 to 199 of dataset iSpp2Q3G60uWDLOi0

- WANT `get-dataset-items`
- ARGS `{"datasetId": "iSpp2Q3G60uWDLOi0", "limit": 100, "offset": 100}`

### `get-dataset-list`

**`pr/get-dataset-list/include-unnamed`**

> list all my datasets, including the temporary unnamed ones

- WANT `get-dataset-list`
- ARGS `{"unnamed": true}`

**`pr/get-dataset-list/lazy-what-data-i-have`**

> what datasets do i have lying around

- WANT `get-dataset-list`

### `get-dataset-schema`

**`pr/get-dataset-schema/from-ten-items`**

> work out the schema of dataset iSpp2Q3G60uWDLOi0 off the first 10 rows

- WANT `get-dataset-schema`
- ARGS `{"datasetId": "iSpp2Q3G60uWDLOi0", "limit": 10}`

**`pr/get-dataset-schema/json-schema-for-dataset`**

> i need the json schema for dataset iSpp2Q3G60uWDLOi0

- WANT `get-dataset-schema`
- ARGS `{"datasetId": "iSpp2Q3G60uWDLOi0"}`

**`pr/get-dataset-schema/lazy-what-shape`**

> what do the records in dataset iSpp2Q3G60uWDLOi0 look like, field wise

- WANT `get-dataset-schema` or `get-dataset`

### `get-key-value-store`

**`pr/get-key-value-store/lazy-store-info`**

> tell me about store rMrkxdMEem3a3BGt4

- WANT `get-key-value-store`
- ARGS `{"keyValueStoreId": "rMrkxdMEem3a3BGt4"}`

**`pr/get-key-value-store/size-check`**

> how big is key value store rMrkxdMEem3a3BGt4

- WANT `get-key-value-store`

### `get-key-value-store-keys`

**`pr/get-key-value-store-keys/first-five`**

> just the first 5 keys in store rMrkxdMEem3a3BGt4 please

- WANT `get-key-value-store-keys`
- ARGS `{"keyValueStoreId": "rMrkxdMEem3a3BGt4", "limit": 5}`

**`pr/get-key-value-store-keys/lazy-whats-in-there`**

> whats saved in store rMrkxdMEem3a3BGt4

- WANT `get-key-value-store-keys` or `get-key-value-store`

### `get-key-value-store-list`

**`pr/get-key-value-store-list/include-unnamed`**

> show me every key value store i have, temporary ones included

- WANT `get-key-value-store-list`
- ARGS `{"unnamed": true}`

**`pr/get-key-value-store-list/lazy-my-stores`**

> list my key value stores

- WANT `get-key-value-store-list`

### `get-key-value-store-record`

**`pr/get-key-value-store-record/input-of-run`**

> what input was used? its in store rMrkxdMEem3a3BGt4 under INPUT

- WANT `get-key-value-store-record`
- ARGS `{"keyValueStoreId": "rMrkxdMEem3a3BGt4", "recordKey": "INPUT"}`

**`pr/get-key-value-store-record/lazy-output`**

> get me OUTPUT from store rMrkxdMEem3a3BGt4

- WANT `get-key-value-store-record`
- ARGS `{"keyValueStoreId": "rMrkxdMEem3a3BGt4", "recordKey": "OUTPUT"}`

### `get-schedule`

**`pr/get-schedule/lazy-when-next`**

> when does eval-nightly-sum fire next

- WANT `get-schedule`
- ARGS `{"scheduleId": "eval-nightly-sum"}`

**`pr/get-schedule/read-before-replacing-actions`**

> add my task eval-sum-nightly to the eval-nightly-sum schedule as well

- WANT `get-schedule`

### `publish-actor-task`

**`pr/publish-actor-task/lazy-make-public`**

> put eval-sum-nightly up on the actors public page

- WANT `publish-actor-task` or `get-actor-task`

**`pr/publish-actor-task/let-people-find-it`**

> i want other people to be able to find eval-sum-nightly

- WANT `publish-actor-task` or `get-actor-task`

### `report-problem`

**`pr/report-problem/broken-tool-complaint`**

> your call-actor tool keeps erroring out, tell someone about it

- WANT `report-problem`

### `search-actors`

**`pr/search-actors/lazy-linkedin-jobs-typo`**

> smth that can scrape linkedn job postings?

- WANT `search-actors`

**`pr/search-actors/lazy-tiktok-comments-need`**

> need tiktok comments for a project, no clue where to start

- WANT `search-actors`

**`pr/search-actors/limit-three-amazon-reviews`**

> give me just 3 options for scraping amazon reviews

- WANT `search-actors`
- ARGS `{"limit": 3}`

**`pr/search-actors/tool-not-data-maps-reviews`**

> i need something i can run every week to pull google maps reviews

- WANT `search-actors`

### `search-apify-docs`

**`pr/search-apify-docs/lazy-how-proxy-works`**

> how does apify proxy work

- WANT `search-apify-docs`

**`pr/search-apify-docs/lazy-webhooks-setup`**

> how do i set up webhooks on apify

- WANT `search-apify-docs`

**`pr/search-apify-docs/vs-web-search-standby`**

> docs on actor standby mode

- WANT `search-apify-docs`

### `unpublish-actor-task`

**`pr/unpublish-actor-task/hide-not-delete`**

> hide eval-sum-nightly from the public but dont delete it

- WANT `unpublish-actor-task` or `get-actor-task`

**`pr/unpublish-actor-task/lazy-take-down`**

> take eval-sum-nightly off the public page

- WANT `unpublish-actor-task` or `get-actor-task`

### `update-actor-task`

**`pr/update-actor-task/landing-page-title`**

> the public page title for eval-sum-nightly should say Nightly sum

- WANT `update-actor-task` or `get-actor-task`

**`pr/update-actor-task/lazy-change-numbers`**

> change my task eval-sum-nightly to add 10 and 20 instead

- WANT `update-actor-task` or `get-actor-task`

**`pr/update-actor-task/switch-build`**

> point task eval-sum-nightly at the test build

- WANT `update-actor-task` or `get-actor-task`

### `update-schedule`

**`pr/update-schedule/change-frequency`**

> make eval-nightly-sum run every 6 hours instead

- WANT `update-schedule` or `get-schedule`

**`pr/update-schedule/lazy-pause`**

> pause eval-nightly-sum for now

- WANT `update-schedule` or `get-schedule`

**`pr/update-schedule/turn-back-on`**

> turn eval-nightly-sum back on

- WANT `update-schedule` or `get-schedule`


---

## merge tier — 37 `agent` cases

`PASS/FAIL` is the judge-facing reference verbatim. The judge sees tool calls and arguments and
the agent's final text, never tool results, so references must only require what is observable.

### `merge/actors/*`

**`merge/actors/cost-and-input-before-running`** — category `fetch-actor-details`, 10 turns

> before i run anything - whats apidojo/tweet-scraper going to cost me and what do i actually have to give it as input

PASS/FAIL: PASS only if fetch-actor-details was called for apidojo/tweet-scraper and the final answer states both a pricing fact and at least one concrete input field from the Actor's schema. FAIL if the agent runs the Actor, or answers from memory without any tool call.

**`merge/actors/nonexistent-actor-graceful`** — category `fetch-actor-details`, 8 turns

  tools allowed to fail: `fetch-actor-details`

> whats apify/totally-made-up-actor-xyz do

PASS/FAIL: PASS only if the agent attempted to look the Actor up with a tool and then told the user plainly that it does not exist. FAIL if it fabricates a description, or silently answers about a different Actor without saying it substituted one.

**`merge/actors/run-and-report-output`** — category `call-actor`, 12 turns

> i want to try apifys hello world actor, just run it and tell me what comes out

PASS/FAIL: PASS only if call-actor was called for apify/hello-world and the final answer reports the Actor's actual output text (the 'Hello world!' message). The agent may obtain it from the run result, the run's dataset, or its key-value store - any of those is fine. FAIL if the answer states an output that no tool call returned, or if the agent claims it cannot run Actors.

**`merge/actors/vague-need-shortlist`** — category `search-actors`, 12 turns

> need to get reviews off google maps, cheap as possible, i cant code

PASS/FAIL: PASS only if search-actors was called and the final answer recommends at least two named Actors with something about their cost or ease of use. The judge cannot see tool results, so do NOT penalise slugs or figures for looking too specific - assume anything the agent reports after a successful search came from it. FAIL only if search-actors was never called, or the agent asked a clarifying question instead of searching.

### `merge/dev/*`

**`merge/dev/report-after-failure`** — category `report-problem`, 8 turns

  forced failures: `call-actor`

> use the apify/website-content-crawler actor to pull https://docs.apify.com/platform and summarise it for me

PASS/FAIL: PASS only if, after the Actor call failed, the agent BOTH told the user it could not complete the task AND called report-problem about that failure without being asked to. FAIL if it answered from memory as though the tool had worked, or never reported the problem.

### `merge/docs/*`

**`merge/docs/how-do-i-with-citation`** — category `search-apify-docs`, 12 turns

> how do i make an actor run on a schedule from the api? link me the docs

PASS/FAIL: PASS only if search-apify-docs was called and the final answer both answers the question and cites at least one docs.apify.com URL. The judge cannot see tool results, so do NOT penalise a URL for looking specific or for not being verifiable - assume any docs.apify.com link the agent gives after a successful search came from that search. FAIL only if no docs tool was called, or the answer cites nothing.

**`merge/docs/search-then-read-page`** — category `fetch-apify-docs`, 12 turns

> whats the difference between actor standby and a normal run, according to the docs

PASS/FAIL: PASS only if the agent searched the Apify docs and then fetched at least one docs page before answering, and the final answer describes the difference between standby and a normal run. FAIL if the agent answers from memory with no tool call, or claims to have read a page it never fetched.

### `merge/runs/*`

**`merge/runs/any-failures-recently`** — category `get-actor-run-list`, 8 turns

> anything of mine failed recently?

PASS/FAIL: PASS only if the run list was fetched filtered to failed runs (a FAILED status filter) and the final answer either names the failed runs or states plainly that there are none. Listing every run and leaving the user to work it out is a FAIL, as is inventing run ids.

**`merge/runs/last-run-status-lazy`** — category `get-actor-run-list`, 10 turns

> did my last run finish ok?

PASS/FAIL: PASS only if the agent listed the user's runs with a tool to find the most recent one, and the final answer states that run's status and which Actor it belonged to. FAIL if the agent asks the user for a run id instead of listing runs, or states a status it never read from a tool result.

**`merge/runs/log-not-just-status`** — category `get-actor-run-log`, 10 turns

> show me what my last run actually logged, not just the status

PASS/FAIL: PASS only if get-actor-run-log was called for the most recent run and the final answer quotes or summarises real log content from that result. FAIL if the agent reports only the run status, or claims logs are unavailable without calling the log tool.

**`merge/runs/start-then-abort`** — category `abort-actor-run`, 14 turns

  tools allowed to fail: `abort-actor-run`

> start apify/rag-web-browser searching for 'apify mcp server' and then actually never mind, kill it straight away

PASS/FAIL: PASS only if the run was started and abort-actor-run was then called with that same run's id. If the run had already finished before the abort landed, reporting that truthfully is also a PASS. FAIL if the agent claims to have aborted the run without calling abort-actor-run, or aborts a different run id than the one it started.

### `merge/schedules/*`

**`merge/schedules/add-keep-existing`** — category `update-schedule`, 12 turns

> also run apify/hello-world on the eval-sched-target schedule, keep whatever is already on it

PASS/FAIL: PASS only if the agent read eval-sched-target first and then updated it with an actions list containing BOTH the action it already had AND the new apify/hello-world action. FAIL if the update sends only the new action, dropping the existing one.

**`merge/schedules/create-then-remove`** — category `delete-schedule`, 12 turns

> set up apify/hello-world to run daily at 4am, name it eval-sched-temp - actually, delete it again once its made, i just want to see that it works

PASS/FAIL: PASS only if create-schedule created eval-sched-temp and delete-schedule then removed it, with the final answer confirming both steps. FAIL if the schedule is left in place, or merely disabled instead of deleted.

**`merge/schedules/name-collision`** — category `create-schedule`, 10 turns

  tools allowed to fail: `create-schedule`

> set up a schedule called eval-nightly-sum that runs my task eval-sum-nightly every day at 3am utc

PASS/FAIL: A schedule named eval-nightly-sum already exists, so create-schedule must fail with a name-not-unique error. PASS only if the agent attempted the create, and then told the user plainly that a schedule with that name already exists - it may stop and ask how to proceed, or propose a different name. FAIL if it silently picks another name and reports success as though the requested name was used, or claims the schedule was created.

**`merge/schedules/not-found-honest`** — category `get-schedule`, 6 turns

  tools allowed to fail: `get-schedule`

> when does my eval-sched-does-not-exist schedule run next

PASS/FAIL: PASS only if the agent looked the schedule up with a tool and then told the user it does not exist. FAIL if it invents a next-run time, or reports on a different schedule without saying it substituted one.

**`merge/schedules/pause-not-delete`** — category `update-schedule`, 8 turns

> stop eval-nightly-sum from firing for a while, im debugging something

PASS/FAIL: PASS if the agent ended with the schedule eval-nightly-sum not firing AND said so: either it called update-schedule to disable it, or it read the schedule, found it already disabled, and reported that plainly. FAIL if delete-schedule was called, or if the agent neither changed nor reported the schedule's enabled state.

**`merge/schedules/weekday-morning-prague`** — category `create-schedule`, 10 turns

> run eval-sum-nightly every weekday at 7:30 prague time, name it eval-sched-weekday

PASS/FAIL: PASS only if create-schedule created a schedule named eval-sched-weekday that targets the eval-sum-nightly task and fires at 07:30 on Monday to Friday only, with the Prague time zone set (or the hour correctly converted to UTC). FAIL if the cron fires all seven days, or if the time is left at 7:30 UTC with no time zone set.

### `merge/storage/*`

**`merge/storage/all-rows-one-call`** — category `get-dataset-items`, 16 turns

> search the web with apify for 'apify mcp server' and give me 5 results, then pull all of them back in one go and tell me how many you got

PASS/FAIL: PASS only if the Actor was run, get-dataset-items was then called with that run's datasetId in a SINGLE call carrying an explicit limit of at least the number of results requested (a limit equal to the requested count is sufficient and should PASS), and the final answer states how many rows came back. FAIL if get-dataset-items was called repeatedly to page through the dataset, if no explicit limit was passed at all, or if the reported count came from nowhere.

**`merge/storage/count-lag-honesty`** — category `get-dataset`, 10 turns

> how many items are in my newest dataset

PASS/FAIL: PASS only if the agent read the dataset's item count with a tool and the final answer reports the count it read. A reported count of zero is NOT a failure, and an agent noting that a freshly written count can lag behind the items is a good answer, not an admission of error. FAIL only if the agent states a count that no tool result returned.

**`merge/storage/dig-out-a-run-input`** — category `get-key-value-store-record`, 14 turns

> i need the input that was used for one of my recent runs, dig it out for me

PASS/FAIL: PASS only if the agent located a recent run, then read that run's key-value store - listing its keys and/or reading the INPUT record - and reported input values that came from the tool result. FAIL if the agent reports an input it never read, or gives up without attempting the key-value store tools.

**`merge/storage/run-then-pick-fields`** — category `get-dataset-items`, 16 turns

> run apify/rag-web-browser for 'what is the apify mcp server', i only want the page titles and urls out of it

PASS/FAIL: PASS only if the Actor was run and get-dataset-items was then called with that run's datasetId AND a fields selection naming the title and url fields, and the final answer lists titles with their urls. FAIL if the agent fetches every field and narrows only in its own prose, or reports results without calling get-dataset-items.

**`merge/storage/shape-without-dumping`** — category `get-dataset-schema`, 12 turns

> whats the structure of the data in my newest dataset? dont dump the whole thing on me

PASS/FAIL: PASS only if the agent found a dataset via a list tool and then described its field structure using the dataset schema or dataset metadata tool, without pulling the full item contents. FAIL if it fetches all items to infer the shape while a schema tool was available, or names fields no tool result contained.

**`merge/storage/what-data-do-i-have`** — category `get-dataset-list`, 10 turns

> what data do i have sitting on apify

PASS/FAIL: PASS only if the agent listed the account's storages with a tool (datasets and/or key-value stores) and the final answer summarises what came back. FAIL if the agent asks which storage the user means without listing anything first, or names storages that no tool result contained.

### `merge/tasks/*`

**`merge/tasks/change-stored-input`** — category `update-actor-task`, 10 turns

> my eval-sum-nightly task should add 100 and 200 from now on

PASS/FAIL: PASS only if update-actor-task was called for the existing eval-sum-nightly task with an input carrying 100 and 200, and the final answer confirms the change. FAIL if a new task was created instead of updating the existing one.

**`merge/tasks/name-collision`** — category `create-actor-task`, 12 turns

  tools allowed to fail: `create-actor-task`

> make me a task called eval-sum-hourly for apify/normal-mode-test-actor adding 3 and 4. then make another one, same name, same actor, adding 7 and 8. tell me exactly what happened with each

PASS/FAIL: Task names are unique per account, so the second create must fail with a name conflict. PASS only if the first create succeeded, a second create with the same name was attempted and failed, and the final answer states plainly that the first was created and the second was rejected because the name is taken. FAIL if the agent silently renames the second task, or reports both as created.

**`merge/tasks/publish-requirement-discovery`** — category `publish-actor-task`, 16 turns

  tools allowed to fail: `publish-actor-task`

> put eval-sum-nightly up on its actors public page so people can see what it does

PASS/FAIL: PASS if the task ends up published, by whichever route: attempting the publish, reading the missing requirements out of the error and filling them in, OR setting the requirements up front and publishing in one pass. If publishing could not be completed, PASS only if the agent names the specific requirement still missing. FAIL if the agent stops at the first error without acting on what it named, or claims the task is published without a successful publish call.

**`merge/tasks/save-my-setup`** — category `create-actor-task`, 10 turns

> i keep rerunning apify/normal-mode-test-actor with 8 and 9, save that so i dont have to retype it. call it eval-sum-eight-nine

PASS/FAIL: PASS only if create-actor-task created a task named eval-sum-eight-nine for apify/normal-mode-test-actor whose stored input carries the numbers 8 and 9, and the final answer confirms it was saved. FAIL if a schedule was created instead of a task, or success is claimed without a successful create call.

**`merge/tasks/save-publish-check-remove`** — category `tasks-chain`, 18 turns

  tools allowed to fail: `publish-actor-task`

> make a one-click version of apify/normal-mode-test-actor called eval-nmta-cycle that adds 2 and 3, put it up publicly, check its actually live, then take it back down

PASS/FAIL: PASS only if a task named eval-nmta-cycle was created for apify/normal-mode-test-actor, published, its published state then confirmed by reading the task back, and finally unpublished - with the final answer reporting all four steps. FAIL if any of the four is claimed without its tool call succeeding. If publishing cannot be completed because a requirement could not be met, saying so plainly and stopping there is also a PASS.

### `merge/web/*`

**`merge/web/escalate-when-blocked`** — category `web-selection`, 14 turns

  tools allowed to fail: `apify--rag-web-browser`

> read https://www.reddit.com/r/webscraping/ and tell me the top post titles

PASS/FAIL: PASS if the page content was retrieved and real post titles reported, by whichever route worked. If the first attempt came back blocked, empty or errored, the agent must have escalated to the dedicated single-URL fetch tool rather than giving up. A truthful report that the page could not be retrieved after trying both routes is also a PASS. FAIL if the agent reports titles it never retrieved.

**`merge/web/list-the-links`** — category `apify--web-fetch`, 12 turns

> list every link on https://example.com for me

PASS/FAIL: PASS only if the fetch tool was called for https://example.com and the final answer lists the link(s) found on it. Requesting the 'links' output format is the direct path; extracting links from fetched page content is equally acceptable. FAIL if links are reported without any fetch, or the agent claims it cannot extract links.

**`merge/web/markup-not-cleaned-up`** — category `apify--web-fetch`, 12 turns

> i need the actual html source of https://example.com, not a tidied up version

PASS/FAIL: The user asked for the page's markup, so the fetch must request a markup-preserving output format - 'html' or 'raw' both satisfy this. PASS only if the fetch tool was called for https://example.com with such a format and the final answer shows the markup. FAIL if the page was returned only as markdown or plain text, or if no fetch was made.

**`merge/web/pdf-to-text`** — category `apify--web-fetch`, 12 turns

> whats actually written in this pdf https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf

PASS/FAIL: The fetch Actor converts PDFs to Markdown. PASS only if the fetch tool was called with that PDF url, the output was retrieved, and the final answer states the PDF's actual text. FAIL if the agent says it cannot read PDFs without trying, or reports text it did not retrieve.

**`merge/web/query-not-a-url`** — category `apify--rag-web-browser`, 12 turns

> whats the general consensus online about apify vs scrapy

PASS/FAIL: PASS only if the agent ran a web search by query rather than fetching a single guessed URL, and the final answer summarises what several sources said. FAIL if the agent invents a specific URL and fetches that instead of searching.

**`merge/web/reports-404-truthfully`** — category `apify--web-fetch`, 12 turns

> grab https://www.rfc-editor.org/rfc/rfc99999.txt and tell me exactly what came back

PASS/FAIL: That URL returns HTTP 404. The fetch run itself still succeeds and records the status code. PASS only if the fetch tool was called with that url and the final answer reports that the page was not found / returned 404. FAIL if the agent presents unrelated content as though it were that page, or claims success without naming the error status.

**`merge/web/unreachable-host`** — category `apify--web-fetch`, 12 turns

  tools allowed to fail: `apify--web-fetch`

> whats on https://this-domain-definitely-does-not-exist-9x7q2.com

PASS/FAIL: The domain does not resolve. Depending on routing the run either fails with a connection error or succeeds with an empty item carrying a proxy error - both mean the same thing. PASS only if the agent attempted the fetch and then told the user the site could not be reached. FAIL if it invents content, or silently substitutes a different domain.

**`merge/web/unsupported-scheme-honesty`** — category `apify--web-fetch`, 12 turns

  tools allowed to fail: `apify--web-fetch`

> grab ftp://ftp.rfc-editor.org/in-notes/rfc9110.txt for me

PASS/FAIL: PASS only if the final answer tells the user that the ftp:// scheme is not supported by the fetch tool. Quietly rewriting the address to https:// and presenting that result as the requested fetch is a FAIL, even when the content returned is correct.

**`merge/web/verbatim-single-url`** — category `apify--web-fetch`, 16 turns

  tools allowed to fail: `call-actor`

> pull up https://www.rfc-editor.org/rfc/rfc9110.html and tell me what it says about the GET method, in its own words not yours

PASS/FAIL: PASS only if that exact URL was fetched with a tool and the final answer conveys what the document says about the GET method, drawing on the fetched content. The page is long, so a partial or summarised account of the GET section is fine as long as it plainly came from the fetch. FAIL if a different URL was fetched, if the answer is delivered from memory with no successful fetch, or if the agent never gives a final answer at all.


---

## v1 case text not carried over

**Read this as "which wordings were retired", not "what was lost".** Every v1 id appears here,
because Langfuse ids are project-unique forever and the new cases had to take new ones — so a
one-to-one id mapping was never possible. Coverage is a separate question and was checked
separately: no tool and no argument group is covered by v1 alone (see `mcp_tool_coverage_evals.md`).

What is genuinely gone is the duplication. Each heading shows how many new cases cover that tool,
so a line like "13 dropped, 3 new" means thirteen near-identical phrasings became three that
each probe a distinct boundary.

### PR tier — all 125 v1 ids retired, 74 new cases replace them

**`abort-actor-run`** — 1 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/abort-actor-run/stuck-run` — My Actor run y2h7sK3Wc is definitely stuck — I've already checked, it's been running for hours with no progres

**`apify--rag-web-browser`** — 13 v1 wording(s) retired, 3 new case(s) cover this tool

- `pr/apify--rag-web-browser/ai-articles-tech-blogs` — Get recent AI articles on tech blogs
- `pr/apify--rag-web-browser/ai-articles-wired-verge` — Get current articles about AI from major tech publications
- `pr/apify--rag-web-browser/ai-blog-articles` — Get recent articles about AI from tech blogs
- `pr/apify--rag-web-browser/ai-news-current` — Fetch current news articles on AI
- `pr/apify--rag-web-browser/climate-change-articles` — Fetch recent articles about climate change
- `pr/apify--rag-web-browser/flight-prices-nyc-london` — Get flight prices from New York to London for tomorrow
- `pr/apify--rag-web-browser/iphone-launch-reactions` — Find out what people are saying online about the new iPhone launch
- `pr/apify--rag-web-browser/news-cnn-bbc` — Fetch AI-related news from CNN and BBC
- `pr/apify--rag-web-browser/ny-weather-forecast` — Get the latest weather forecast for New York
- `pr/apify--rag-web-browser/sf-weather-forecast` — Get the latest weather forecast for San Francisco
- `pr/apify--rag-web-browser/sf-weather-today` — What's the weather like today in San Francisco?
- `pr/apify--rag-web-browser/tech-industry-news` — Get the latest tech industry news
- `pr/call-actor/rag-web-browser` — Use the RAG web browser Actor (apify/rag-web-browser) to search the web for 'latest news on AI regulation' and

**`apify--web-fetch`** — 1 v1 wording(s) retired, 4 new case(s) cover this tool

- `pr/web-fetch/example-com` — Fetch https://example.com and tell me what it says.

**`call-actor`** — 6 v1 wording(s) retired, 4 new case(s) cover this tool

- `pr/call-actor/ecommerce-scraper-iphone` — Scrape iPhone15 at Amazon using apify/e-commerce-scraping-tool
- `pr/call-actor/google-search-restaurants` — Call apify/google-search-scraper to find restaurants in London
- `pr/call-actor/hashtag-research-ai` — Run apify/social-media-hashtag-research for #AI
- `pr/call-actor/instagram-scraper-hashtag` — Run apify/instagram-scraper to scrape #dwaynejohnson
- `pr/call-actor/tweet-scraper-profiles` — Run apidojo/tweet-scraper to scrape twitter profiles
- `pr/call-actor/weather-scraper-nyc` — Call epctex/weather-scraper for New York

**`create-actor-task`** — 3 v1 wording(s) retired, 3 new case(s) cover this tool

- `pr/create-actor-task/google-search-pizza` — Create a task for apify/google-search-scraper that searches for pizza — just create it directly.
- `pr/create-actor-task/instagram-insta-daily` — Create a task called insta-daily that runs apify/instagram-scraper — just create it directly.
- `pr/create-actor-task/not-a-schedule` — Save apify/hello-world with the input message 'hi there' as a reusable task named eval-hello-config.

**`create-schedule`** — 3 v1 wording(s) retired, 4 new case(s) cover this tool

- `pr/create-schedule/actor-weekly-monday` — Schedule apify/hello-world to run every Monday at 8:00 UTC with the input {"message": "weekly ping"}. Name the
- `pr/create-schedule/paused` — Create a schedule eval-sched-paused that runs my task eval-sum-nightly every hour, but keep it switched off fo
- `pr/create-schedule/task-daily-prague` — I already have a task called eval-sum-nightly. Schedule it to run every day at 9:00 Prague time.

**`delete-schedule`** — 1 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/delete-schedule/remove` — Delete my schedule eval-nightly-sum, I don't need it anymore.

**`fetch-actor-details`** — 12 v1 wording(s) retired, 10 new case(s) cover this tool

- `pr/fetch-actor-details/google-search-scraper` — Scrape details of apify/google-search-scraper
- `pr/fetch-actor-details/hashtag-research-features` — Tell me about apify/social-media-hashtag-research features
- `pr/fetch-actor-details/input-schema` — Show me the input schema for apify/rag-web-browser
- `pr/fetch-actor-details/instagram-scraper-capabilities` — What can apify/instagram-scraper do?
- `pr/fetch-actor-details/instagram-scraper-overview` — What are the details of apify/instagram-scraper?
- `pr/fetch-actor-details/instagram-scraper-parameters` — What parameters does apify/instagram-scraper accept?
- `pr/fetch-actor-details/instagram-scraper-pricing` — How much does apify/instagram-scraper cost?
- `pr/fetch-actor-details/nonexistent-actor` — What does apify/totally-made-up-actor-xyz do?
- `pr/fetch-actor-details/rag-web-browser-docs` — Give me the documentation for apify/rag-web-browser
- `pr/fetch-actor-details/rag-web-browser-how-it-works` — How does apify/rag-web-browser work?
- `pr/fetch-actor-details/rag-web-browser-pricing` — What's the pricing model for apify/rag-web-browser?
- `pr/fetch-actor-details/typo-actor-name` — What can apify/instagarm-scraper do?

**`fetch-apify-docs`** — 2 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/fetch-apify-docs/mcp-integration-page` — What does the Apify docs page at https://docs.apify.com/platform/integrations/mcp say?
- `pr/fetch-apify-docs/nonexistent-page` — Check the Apify docs for this page: https://docs.apify.com/nonexistent-page

**`get-actor-log`** — 2 v1 wording(s) retired, 0 new case(s) cover this tool  ⚠️ **asserts a tool that no longer exists** (renamed `get-actor-run-log`); these could never pass

- `pr/get-actor-log/debug-failed-run` — Show me the last 20 log lines for Actor run y2h7sK3Wc — I need to see why it failed.
- `pr/get-actor-log/missing-line-count` — Show me the log for Actor run y2h7sK3Wc.

**`get-actor-run`** — 1 v1 wording(s) retired, 6 new case(s) cover this tool

- `pr/get-actor-run/status` — What is the status of my Actor run with ID abc123XYZ456?

**`get-actor-run-list`** — 1 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/get-actor-run-list/recent-runs` — List my last 10 Actor runs, most recent first.

**`get-actor-task`** — 2 v1 wording(s) retired, 12 new case(s) cover this tool

- `pr/get-actor-task/insta-daily-config` — What is the configuration of my task insta-daily?
- `pr/get-actor-task/insta-daily-published` — Is my task insta-daily published?

**`get-dataset`** — 3 v1 wording(s) retired, 4 new case(s) cover this tool

- `pr/get-dataset/fields-list` — What fields does dataset UvsU contain?
- `pr/get-dataset/item-count` — How many items are in dataset abc123?
- `pr/get-dataset/metadata-stats` — Show me the metadata and stats for dataset des32s

**`get-dataset-items`** — 7 v1 wording(s) retired, 4 new case(s) cover this tool

- `pr/get-dataset-items/all-web-scraper-results` — Retrieve all results from my web scraper with datasetID abc123
- `pr/get-dataset-items/first-50-items` — Get the first 50 items from my datasetId abc123
- `pr/get-dataset-items/instagram-run-data` — Show me the data from my Instagram scraper run with datasetId d23d2
- `pr/get-dataset-items/latest-run-output` — Get output from my latest actor with datasetId des32s
- `pr/get-dataset-items/query-markdown-fields` — Get query and markdown fields from dataset UvsU
- `pr/get-dataset-items/retrieve-results` — Retrieve results from dataset abc123
- `pr/get-dataset-items/select-title-url-fields` — Retrieve only the title and url fields from dataset UvsU

**`get-dataset-list`** — 3 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/get-dataset-list/account-datasets` — What datasets do I have in my account?
- `pr/get-dataset-list/last-10-newest-first` — Show me my last 10 datasets, newest first
- `pr/get-dataset-list/list-all` — List all my datasets

**`get-dataset-schema`** — 3 v1 wording(s) retired, 3 new case(s) cover this tool

- `pr/get-dataset-schema/basic-schema` — What is the schema of dataset abc123?
- `pr/get-dataset-schema/generate-from-10-items` — Generate a JSON schema for dataset des32s using 10 items
- `pr/get-dataset-schema/infer-structure` — Infer the structure of the items in dataset UvsU

**`get-key-value-store`** — 2 v1 wording(s) retired, 3 new case(s) cover this tool

- `pr/get-key-value-store/details` — Get details about key-value store des32s
- `pr/get-key-value-store/metadata` — Show me the metadata for key-value store abc123

**`get-key-value-store-keys`** — 2 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/get-key-value-store-keys/list-keys` — List the keys in key-value store abc123
- `pr/get-key-value-store-keys/which-keys-stored` — What keys are stored in my key-value store des32s?

**`get-key-value-store-list`** — 2 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/get-key-value-store-list/account-stores` — What key-value stores do I have in my account?
- `pr/get-key-value-store-list/list-all` — List all my key-value stores

**`get-key-value-store-record`** — 3 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/get-key-value-store-record/data-json-record` — Fetch the contents of key data.json from store UvsU
- `pr/get-key-value-store-record/input-record` — Get record INPUT from key-value store abc123
- `pr/get-key-value-store-record/output-record` — Read the value under key OUTPUT in key-value store des32s

**`get-schedule`** — 2 v1 wording(s) retired, 7 new case(s) cover this tool

- `pr/get-schedule/add-action-reads-first` — Add my task eval-sum-nightly to the schedule eval-nightly-sum.
- `pr/get-schedule/next-run` — When will my schedule eval-nightly-sum run next?

**`publish-actor-task`** — 3 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/publish-actor-task/insta-daily` — Publish my task insta-daily
- `pr/publish-actor-task/insta-daily-make-public` — Make my task insta-daily public
- `pr/publish-actor-task/write-access-granted` — I now have write access to my task insta-daily and its Actor now — publish it.

**`search-actors`** — 27 v1 wording(s) retired, 4 new case(s) cover this tool

- `pr/search-actors/amazon-product-details` — I need to find solution to scrape details of Amazon products
- `pr/search-actors/amazon-product-scrapers` — Show me Amazon product scrapers
- `pr/search-actors/data-extraction-tasks` — Find actors for data extraction tasks
- `pr/search-actors/ecommerce-data-extraction` — What tools can extract data from e-commerce sites?
- `pr/search-actors/facebook-data` — Find an Actor to get Facebook data
- `pr/search-actors/flight-data-booking-sites` — Find an Actor that scrapes flight data from booking sites
- `pr/search-actors/flight-data-extraction` — Find actors for flight data extraction
- `pr/search-actors/instagram-ai-posts` — Find posts about AI on Instagram
- `pr/search-actors/instagram-posts` — What Actors can scrape Instagram posts?
- `pr/search-actors/instagram-posts-ai` — Scrape Instagram posts about AI
- `pr/search-actors/instagram-posts-generic` — Find an Actor to get instagram posts
- `pr/search-actors/instagram-posts-the-rock` — Find posts about the Rock on Instagram
- `pr/search-actors/instagram-profile-scraping` — I need to find Actor for instagram profile scraping
- `pr/search-actors/instagram-scrapers-best` — What are the best Instagram scrapers?
- `pr/search-actors/news-articles` — Find actors that can scrape news articles
- `pr/search-actors/playwright-mcp-server` — Find an Actor that can automate a headless browser using Playwright.
- `pr/search-actors/skyscanner-flights` — Find an Actor to get flight information from Skyscanner
- `pr/search-actors/social-media-scraping` — Find actors for scraping social media
- `pr/search-actors/stackoverflow-quicksort` — Use Apify to scrape StackOverflow for the top 10 most upvoted quicksort implementations in Python
- `pr/search-actors/tiktok-comments-lazy-budget` — I'm new to Apify, I can't really code, I need data from my project, I need tiktok comments. I'm also price sen
- `pr/search-actors/tiktok-content` — What actors can scrape TikTok content?
- `pr/search-actors/tiktok-scraper` — What is the best TikTok scraper on Apify?
- `pr/search-actors/twitter-ai-posts` — Find an Actor to fetch posts from Twitter about AI
- `pr/search-actors/twitter-scraping-tools` — Show me Twitter scraping tools
- `pr/search-actors/vague-scraping-need` — I want to scrape LinkedIn profiles but I don't know which Actor to use for that.
- `pr/search-actors/weather-data-scraping` — Can you find actors to scrape weather data?
- `pr/search-actors/weather-scraping-tools` — Search for weather data scraping tools

**`search-apify-docs`** — 10 v1 wording(s) retired, 3 new case(s) cover this tool

- `pr/search-apify-docs/actor-docs-overview` — Show me Apify Actor documentation
- `pr/search-apify-docs/api-integration-guide` — Search the Apify docs for the API integration guide
- `pr/search-apify-docs/apify-proxy-usage` — How to use Apify Proxy
- `pr/search-apify-docs/build-actor-from-scratch` — How do I build my own Apify Actor from scratch?
- `pr/search-apify-docs/build-actor-guide` — How to build an Apify Actor
- `pr/search-apify-docs/crawlee-web-scraping` — How to do web scraping with Crawlee in the Apify docs
- `pr/search-apify-docs/error-handling-actors` — Error handling in Actors
- `pr/search-apify-docs/input-schema-examples` — Ho to define Actor input schema, provide examples
- `pr/search-apify-docs/mcp-server-docs` — Is there documentation for the Apify MCP server?
- `pr/search-apify-docs/playwright-with-apify` — How to use Playwright library with Apify

**`unpublish-actor-task`** — 2 v1 wording(s) retired, 2 new case(s) cover this tool

- `pr/unpublish-actor-task/insta-daily` — Unpublish my task insta-daily
- `pr/unpublish-actor-task/insta-daily-keep-display-settings` — Take my task insta-daily off its public page but keep its display settings

**`update-actor-task`** — 5 v1 wording(s) retired, 3 new case(s) cover this tool

- `pr/publish-actor-task/query-input-overview-view` — Set up my task insta-daily's public page with the query input field and the overview dataset view before I pub
- `pr/update-actor-task/insta-daily-beta-build` — Change my task insta-daily to use the beta build
- `pr/update-actor-task/insta-daily-change-input` — I already have a task called insta-daily, change its input to search for cats instead
- `pr/update-actor-task/insta-daily-landing-title` — Set the landing page title of my task insta-daily to 'Daily Instagram scraper'
- `pr/update-actor-task/publish-view-setup` — Set up my task insta-daily for publishing, using the overview dataset view

**`update-schedule`** — 3 v1 wording(s) retired, 3 new case(s) cover this tool

- `pr/update-schedule/every-6-hours` — Change my schedule eval-nightly-sum to run every 6 hours.
- `pr/update-schedule/pause` — Pause my schedule eval-nightly-sum.
- `pr/update-schedule/resume` — Turn my schedule eval-nightly-sum back on.

### merge tier — all 70 v1 ids retired, 37 new cases replace them

**`merge/mcp-agent/*`** — 30 v1 case(s) retired

- `merge/mcp-agent/call-actor-mcp-weather` — Find a weather mcp Actor and use it through the call-actor tool to show me the current weather in Prague
- `merge/mcp-agent/call-google-maps-restaurants` — Find the top 3 restaurants in Prague using the Google Maps Scraper, I want to know their names, ratings and ad
- `merge/mcp-agent/call-tiktok-scraper` — Show me 1 latest post from natgeo tik tok using Apify
- `merge/mcp-agent/discover-and-call-actor-mcp-tool` — List the tools exposed by apify/example-mcp-server. Then use its add tool to add 17 and 25, and tell me the su
- `merge/mcp-agent/fetch-details-mcp-tools-list` — Show me what tools are available in the apify/example-mcp-server MCP server
- `merge/mcp-agent/fetch-details-non-mcp-actor-graceful` — Show me MCP tools for apify/instagram-scraper
- `merge/mcp-agent/instagram-posts` — Show me 1 latest post from the natgeo instagram profile
- `merge/mcp-agent/report-problem-on-tool-error` — Use the apify/rag-web-browser Actor to scrape https://example.com and tell me the page title.
- `merge/mcp-agent/search-add-call-python-actor` — Find example Python Actor and call it with random sample input and present the results
- `merge/mcp-agent/search-generic-scrapers` — What is the best scraper tool to extract website content?
- `merge/mcp-agent/search-google-maps` — Is there any Google Maps scraping tool on Apify?
- `merge/mcp-agent/search-instagram-scrapers` — What is the best instagram scraper on Apify?
- `merge/mcp-agent/search-tiktok-scrapers` — What is the best tiktok scraper on Apify?
- `merge/mcp-agent/storage-actor-run-list-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1, waiting up to
- `merge/mcp-agent/storage-actor-run-status-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1, waiting up to
- `merge/mcp-agent/storage-dataset-items-google-search` — Run a Google search via Apify for 'apify web scraping' and request the top 15 organic results. When the run fi
- `merge/mcp-agent/storage-dataset-items-hotels-bulk` — Use the Google Maps Scraper to find at least 20 hotels in Vienna. When the run finishes, retrieve all the resu
- `merge/mcp-agent/storage-dataset-items-instagram` — Scrape the 15 latest posts from the natgeo Instagram profile using Apify. When the run finishes, retrieve only
- `merge/mcp-agent/storage-dataset-items-maps-bulk` — Use the Google Maps Scraper to find the best 20 restaurants in Prague. When the run finishes, retrieve all of 
- `merge/mcp-agent/storage-dataset-items-reddit` — Scrape 15 posts from the r/technology subreddit using Apify. When the run finishes, retrieve only the title an
- `merge/mcp-agent/storage-dataset-items-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1, waiting up to
- `merge/mcp-agent/storage-dataset-items-tiktok` — Scrape the 15 latest TikTok videos from the @natgeo profile using Apify. When the run finishes, retrieve only 
- `merge/mcp-agent/storage-dataset-items-youtube` — Use Apify to scrape 15 videos from the Apify YouTube channel. When the run finishes, retrieve only the title a
- `merge/mcp-agent/storage-dataset-metadata-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ waiting up to 45 seconds for it to fini
- `merge/mcp-agent/storage-dataset-schema-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1, waiting up to
- `merge/mcp-agent/storage-kv-keys-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1, waiting up to
- `merge/mcp-agent/storage-kv-record-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1, waiting up to
- `merge/mcp-agent/storage-run-list-recent` — List my 10 most recent Actor runs, newest first. For each run report its run ID, the Actor it ran, and its sta
- `merge/mcp-agent/workflow-mcp-discover-and-execute` — Use the apify/example-mcp-server to execute one of its tools
- `merge/mcp-agent/workflow-search-fetch-schema-call` — Find a TikTok scraper, check what input it needs, and run it to get 5 videos from user @example

**`merge/schedules/*`** — 10 v1 case(s) retired

- `merge/schedules/add-action-medium-1` — My schedule eval-sched-target should also run apify/hello-world every time it fires, keeping whatever it alrea
- `merge/schedules/chain-medium-1` — Set up a schedule eval-sched-weekly for apify/hello-world with the input message 'weekly ping', every Monday a
- `merge/schedules/collision-hard-1` — Create a schedule called eval-nightly-sum that runs my task eval-sum-nightly every day at 3:00 UTC.
- `merge/schedules/create-easy-1` — Create a schedule named eval-sched-daily that runs my task eval-sum-nightly every day at 9:00 Prague time, and
- `merge/schedules/cron-hard-1` — I want my task eval-sum-nightly to run on weekdays at half past seven in the morning, New York time. Set that 
- `merge/schedules/delete-hard-1` — Create a schedule eval-sched-temp that runs my task eval-sum-nightly daily at noon UTC and keep it disabled. T
- `merge/schedules/get-easy-1` — Tell me what my schedule eval-nightly-sum runs, how often, and whether it is currently active.
- `merge/schedules/loose-actor-hard-1` — Schedule the Apify hello world actor to run every hour. Call the schedule eval-sched-hourly and leave it switc
- `merge/schedules/notfound-hard-1` — Is my schedule eval-sched-ghost running right now?
- `merge/schedules/pause-easy-1` — Create a schedule eval-sched-pause that runs my task eval-sum-nightly every hour, then pause it right away so 

**`merge/tasks/*`** — 10 v1 case(s) retired

- `merge/tasks/chain-hard-1` — I keep running apify/normal-mode-test-actor with the same two numbers, 8 and 9, over and over. Turn that into 
- `merge/tasks/chain-medium-1` — Set up the Google Maps scraper to search for hotels in Prague and save that configuration under the name eval-
- `merge/tasks/create-collision` — Create a task named eval-sum-hourly for apify/normal-mode-test-actor with firstNumber 3 and secondNumber 4. Th
- `merge/tasks/create-easy-1` — Create a task called eval-sum-daily for the apify/normal-mode-test-actor Actor that runs it with firstNumber 5
- `merge/tasks/get-easy-1` — What Actor does my task eval-sum-nightly run, and what input is it configured with?
- `merge/tasks/get-not-found` — What Actor does my task eval-video-digest run?
- `merge/tasks/publish-discovery` — Create a task named eval-sum-discovery for apify/normal-mode-test-actor that adds 3 and 4, and get it live on 
- `merge/tasks/publish-medium-1` — Create a task named eval-sum-publish for apify/normal-mode-test-actor, set up to add 7 and 5 (its firstNumber 
- `merge/tasks/update-easy-1` — Create a task named eval-sum-weekly for apify/normal-mode-test-actor with firstNumber 1 and secondNumber 2. Th
- `merge/tasks/update-medium-1` — Create a task named eval-sum-monthly for apify/normal-mode-test-actor with firstNumber 2 and secondNumber 3, l

**`merge/web-fetch/*`** — 11 v1 case(s) retired

- `merge/web-fetch/chain-hard-1` — With Apify, find out where the link on https://example.com leads, then fetch that page too and tell me who mai
- `merge/web-fetch/fetch-easy-1` — Use Apify to fetch https://example.com and tell me what the page says.
- `merge/web-fetch/fetch-easy-2` — Use Apify to fetch https://www.rfc-editor.org/rfc/rfc2606.html and tell me which RFC that page holds, its titl
- `merge/web-fetch/format-discovery` — Using Apify, fetch https://httpbin.org/headers as plain text, sending an Accept-Language header of de-DE, and 
- `merge/web-fetch/formats-easy-1` — With Apify, get me the HTML source of https://example.com - the actual markup, not a cleaned-up version.
- `merge/web-fetch/formats-medium-1` — Use Apify to read this PDF and tell me exactly what text it contains: https://www.w3.org/WAI/ER/tests/xhtml/te
- `merge/web-fetch/links-medium-1` — Using Apify, list every link that appears on https://example.com.
- `merge/web-fetch/selection-hard-1` — Grab the content of https://apify.com/store as Markdown and paste it right here in the chat. A plain fetch kee
- `merge/web-fetch/status-hard-1` — Use Apify to fetch https://httpbin.org/status/404 and report exactly what came back - status and content.
- `merge/web-fetch/unreachable` — Use Apify to get the content of https://this-domain-definitely-does-not-exist-9x7q2.com and tell me what's on 
- `merge/web-fetch/unsupported-protocol` — Use Apify to download ftp://ftp.gnu.org/gnu/annual-report-2026.txt and show me what's in it.

**`merge/web-selection/*`** — 9 v1 case(s) retired

- `merge/web-selection/blocked-native` — Can you get me the content of https://www.reddit.com/r/webscraping/ - the sub's description and whatever posts
- `merge/web-selection/chain-medium-1` — Use Apify to double-check where the official Crawlee website lives - search the web rather than trusting memor
- `merge/web-selection/discovery-easy-1` — Use Apify to find me a ready-made tool that can scrape TikTok - give me a couple of options with links.
- `merge/web-selection/fetch-easy-1` — Use Apify to open https://crawlee.dev and give me the full homepage content as Markdown - the whole page, not 
- `merge/web-selection/fetch-medium-1` — Fetch https://www.rfc-editor.org/rfc/rfc2606.html and give me the exact, word-for-word text of section 2, 'TLD
- `merge/web-selection/rag-blocked` — Use Apify's web browser to read https://www.reddit.com/r/webscraping/ for me and tell me what's being discusse
- `merge/web-selection/search-easy-1` — Use Apify to search the web for the Crawlee web scraping library and give me the top 2 results with their link
- `merge/web-selection/search-medium-1` — Use Apify to look up what the web says about the Model Context Protocol - search for recent articles and summa
- `merge/web-selection/structured-hard-1` — Use Apify to get the 3 most recent posts from the public Instagram profile instagram.com/instagram - captions 

