# What changed, case by case

Review material for #1411. Delete once the cases are migrated into the live datasets.

## The files here

| File | What |
|---|---|
| `new_pr_cases.json` | 74 new `tool-call` cases. **Edit these.** |
| `new_merge_cases.json` | 37 new `agent` cases. **Edit these.** |
| `retired_pr_cases.json` | the 125 live PR cases being retired, for reference |
| `retired_merge_cases.json` | the 70 live merge cases being retired, for reference |
| `current_status.json` | per case: passes everywhere, or which models it fails on |

To change a case, edit the JSON and say so. The files upsert straight back into the staging
datasets by `id`, so an edit is a one-command re-push and re-run. Do not edit an `id`: Langfuse
ids are project-unique forever, so a renamed case burns the old id and creates a second case.

## Added, removed, changed

**Every case is new and every v1 case is retired.** That is forced, not a choice: Langfuse ids
cannot move between datasets, so the new cases had to take fresh ids. There is no per-case diff
to read. What follows is the meaningful comparison instead, per tool.

Coverage was checked separately and mechanically: no tool and no argument group is covered by v1
alone. See `../mcp_tool_coverage_evals.md`.

Each new case below carries its closest v1 counterpart, and each retired case its successors, so
you can see what a wording replaced. **This pairing is computed by text similarity, not authored**
- treat it as a hint and check it. Counts:

- 15 new cases: close equivalent
- 17 new cases: possibly related
- 79 new cases: no v1 equivalent
- 28 of 195 retired cases have a successor; the rest were duplicates or consolidations

## Currently failing (18)

Review these first. Each is either a real product finding worth keeping, or a case defect worth
fixing. Three were already misdiagnosed as defects when they were findings, so prefer reading the
transcript over the judge summary.

- `merge/dev/report-after-failure` — FAILS on opus-5, sonnet-5
- `merge/docs/how-do-i-with-citation` — FAILS on opus-5
- `merge/runs/last-run-status-lazy` — FAILS on opus-5, sonnet-5
- `merge/storage/all-rows-one-call` — FAILS on opus-5, sonnet-5
- `merge/storage/dig-out-a-run-input` — FAILS on sonnet-5
- `merge/storage/shape-without-dumping` — FAILS on opus-5
- `merge/tasks/change-stored-input` — FAILS on opus-5, sonnet-5
- `merge/tasks/publish-requirement-discovery` — FAILS on sonnet-5
- `merge/web/verbatim-single-url` — FAILS on opus-5, sonnet-5
- `pr/call-actor/wait-two-minutes` — FAILS on haiku-4-5
- `pr/create-actor-task/not-a-schedule-trap` — FAILS on haiku-4-5, sonnet-5, opus-5
- `pr/delete-schedule/remove-completely-not-pause` — FAILS on haiku-4-5
- `pr/get-actor-run/lazy-is-it-done` — FAILS on opus-5
- `pr/get-actor-run/wait-until-finished` — FAILS on sonnet-5, opus-5
- `pr/rag-web-browser/few-articles-by-topic` — FAILS on sonnet-5
- `pr/report-problem/broken-tool-complaint` — FAILS on opus-5
- `pr/search-actors/limit-three-amazon-reviews` — FAILS on haiku-4-5, sonnet-5, opus-5
- `pr/update-schedule/change-frequency` — FAILS on sonnet-5

## PR tier, by tool

### `abort-actor-run` — 1 retired, 2 new

<details><summary>retired wordings</summary>

- My Actor run y2h7sK3Wc is definitely stuck — I've already checked, it's been running for hours with no progress. Don't check on it, just abort it now.

</details>

- **pr/abort-actor-run/graceful-stop**
  > stop run oQNzVLE4B1CcjtzhS but let it save what it already has
  `abort-actor-run` or `get-actor-run`
  _no v1 equivalent_
- **pr/abort-actor-run/lazy-kill-it**
  > kill run oQNzVLE4B1CcjtzhS, its burning credits
  `abort-actor-run` or `get-actor-run`
  _no v1 equivalent_

### `apify--rag-web-browser` — 13 retired, 3 new

<details><summary>retired wordings</summary>

- Get recent AI articles on tech blogs
- Get current articles about AI from major tech publications
- Get recent articles about AI from tech blogs
- Fetch current news articles on AI
- Fetch recent articles about climate change
- Get flight prices from New York to London for tomorrow
- Find out what people are saying online about the new iPhone launch
- Fetch AI-related news from CNN and BBC
- Get the latest weather forecast for New York
- Get the latest weather forecast for San Francisco
- What's the weather like today in San Francisco?
- Get the latest tech industry news
- Use the RAG web browser Actor (apify/rag-web-browser) to search the web for 'latest news on AI regulation' and summarize the top results.

</details>

- **pr/rag-web-browser/few-articles-by-topic**  ← **FAILS**
  > find me a few articles about prague public transport strikes
  `apify--rag-web-browser`
  _no v1 equivalent_
- **pr/rag-web-browser/lazy-latest-ai-chip-rules**
  > whats the latest on ai chip export rules
  `apify--rag-web-browser`
  _no v1 equivalent_
- **pr/rag-web-browser/search-not-discovery-not-fetch**
  > whats being said online about apify pricing lately
  `apify--rag-web-browser`
  _no v1 equivalent_

### `apify--web-fetch` — 1 retired, 3 new

<details><summary>retired wordings</summary>

- Fetch https://example.com and tell me what it says.

</details>

- **pr/web-fetch/blocked-page-retry**
  > i keep getting 403 trying to read https://www.reddit.com/r/webscraping/ - can you get it for me
  `apify--web-fetch`
  _no v1 equivalent_
- **pr/web-fetch/lazy-single-url-content**
  > whats on https://www.rfc-editor.org/rfc/rfc9110.html
  `apify--web-fetch`
  _no v1 equivalent_
- **pr/web-fetch/links-on-page**
  > list the links on https://docs.apify.com/platform
  `apify--web-fetch`
  _no v1 equivalent_

### `call-actor` — 6 retired, 4 new

<details><summary>retired wordings</summary>

- Scrape iPhone15 at Amazon using apify/e-commerce-scraping-tool
- Call apify/google-search-scraper to find restaurants in London
- Run apify/social-media-hashtag-research for #AI
- Run apify/instagram-scraper to scrape #dwaynejohnson
- Run apidojo/tweet-scraper to scrape twitter profiles
- Call epctex/weather-scraper for New York

</details>

- **pr/call-actor/budget-cap-one-dollar**
  > run apify/google-search-scraper for 'prague coffee' but dont let it cost more than $1
  `call-actor` or `fetch-actor-details`
  _no v1 equivalent_
- **pr/call-actor/lazy-just-run-hello**
  > just run apify/hello-world
  `call-actor` or `fetch-actor-details`
  _possibly related of_ `pr/call-actor/hashtag-research-ai`: Run apify/social-media-hashtag-research for #AI
- **pr/call-actor/memory-cap-512**
  > run apify/hello-world, cap the memory at 512 MB
  `call-actor` or `fetch-actor-details`
  _no v1 equivalent_
- **pr/call-actor/wait-two-minutes**  ← **FAILS**
  > run apify/hello-world and wait up to 2 minutes for it to finish
  `call-actor` or `fetch-actor-details`
  _no v1 equivalent_

### `create-actor-task` — 3 retired, 3 new

<details><summary>retired wordings</summary>

- Create a task for apify/google-search-scraper that searches for pizza — just create it directly.
- Create a task called insta-daily that runs apify/instagram-scraper — just create it directly.
- Save apify/hello-world with the input message 'hi there' as a reusable task named eval-hello-config.

</details>

- **pr/create-actor-task/lazy-save-config**
  > save apify/hello-world as something i can rerun, call it eval-hello-rerun
  `create-actor-task` or `fetch-actor-details`
  _no v1 equivalent_
- **pr/create-actor-task/not-a-schedule-trap**  ← **FAILS**
  > i want to keep this apify/hello-world setup so i dont have to retype it every time, name it eval-hello-keep
  `create-actor-task`
  _no v1 equivalent_
- **pr/create-actor-task/with-stored-input**
  > make a reusable config for apify/normal-mode-test-actor that adds 5 and 7, name it eval-sum-five-seven
  `create-actor-task` or `fetch-actor-details`
  _no v1 equivalent_

### `create-schedule` — 3 retired, 4 new

<details><summary>retired wordings</summary>

- Schedule apify/hello-world to run every Monday at 8:00 UTC with the input {"message": "weekly ping"}. Name the schedule eval-sched-weekly.
- Create a schedule eval-sched-paused that runs my task eval-sum-nightly every hour, but keep it switched off for now.
- I already have a task called eval-sum-nightly. Schedule it to run every day at 9:00 Prague time.

</details>

- **pr/create-schedule/created-paused**
  > set up apify/hello-world to run mondays at 8 but leave it switched off for now, name it eval-sched-mon
  `create-schedule` or `fetch-actor-details`
  _no v1 equivalent_
- **pr/create-schedule/explicit-cron**
  > schedule my task eval-sum-nightly on the cron 0 3 * * * , name it eval-sched-cron
  `create-schedule` or `get-actor-task`
  _no v1 equivalent_
- **pr/create-schedule/lazy-every-morning**
  > run my task eval-sum-nightly every morning at 7
  `create-schedule` or `get-actor-task`
  _possibly related of_ `pr/create-schedule/task-daily-prague`: I already have a task called eval-sum-nightly. Schedule it to run every day at 9:00 Prague time.
- **pr/create-schedule/timezone-prague**
  > kick off eval-sum-nightly at 6am prague time every day
  `create-schedule` or `get-actor-task`
  _possibly related of_ `pr/create-schedule/task-daily-prague`: I already have a task called eval-sum-nightly. Schedule it to run every day at 9:00 Prague time.

### `delete-schedule` — 1 retired, 2 new

<details><summary>retired wordings</summary>

- Delete my schedule eval-nightly-sum, I don't need it anymore.

</details>

- **pr/delete-schedule/lazy-get-rid-of-it**
  > get rid of the eval-nightly-sum schedule
  `delete-schedule` or `get-schedule`
  _possibly related of_ `pr/get-schedule/add-action-reads-first`: Add my task eval-sum-nightly to the schedule eval-nightly-sum.
- **pr/delete-schedule/remove-completely-not-pause**  ← **FAILS**
  > i dont need eval-nightly-sum anymore, remove it completely
  `delete-schedule` or `get-schedule`
  _possibly related of_ `pr/delete-schedule/remove`: Delete my schedule eval-nightly-sum, I don't need it anymore.

### `fetch-actor-details` — 12 retired, 3 new

<details><summary>retired wordings</summary>

- Scrape details of apify/google-search-scraper
- Tell me about apify/social-media-hashtag-research features
- Show me the input schema for apify/rag-web-browser
- What can apify/instagram-scraper do?
- What are the details of apify/instagram-scraper?
- What parameters does apify/instagram-scraper accept?
- How much does apify/instagram-scraper cost?
- What does apify/totally-made-up-actor-xyz do?
- Give me the documentation for apify/rag-web-browser
- How does apify/rag-web-browser work?
- What's the pricing model for apify/rag-web-browser?
- What can apify/instagarm-scraper do?

</details>

- **pr/fetch-actor-details/lazy-cost-tweet-scraper**
  > how much do i pay for apidojo/tweet-scraper
  `fetch-actor-details` · args `{"actor": "apidojo/tweet-scraper"}`
  _no v1 equivalent_
- **pr/fetch-actor-details/lazy-what-input-needed**
  > what do i have to fill in to run apify/google-search-scraper
  `fetch-actor-details` · args `{"actor": "apify/google-search-scraper"}`
  _possibly related of_ `pr/fetch-actor-details/google-search-scraper`: Scrape details of apify/google-search-scraper
- **pr/fetch-actor-details/lazy-whats-it-about**
  > whats apify/instagram-scraper about
  `fetch-actor-details` · args `{"actor": "apify/instagram-scraper"}`
  _close equivalent of_ `pr/fetch-actor-details/instagram-scraper-capabilities`: What can apify/instagram-scraper do?

### `fetch-apify-docs` — 2 retired, 2 new

<details><summary>retired wordings</summary>

- What does the Apify docs page at https://docs.apify.com/platform/integrations/mcp say?
- Check the Apify docs for this page: https://docs.apify.com/nonexistent-page

</details>

- **pr/fetch-apify-docs/explicit-url-page**
  > read https://docs.apify.com/platform/actors/running/input-and-output and summarise it for me
  `fetch-apify-docs` · args `{"url": "https://docs.apify.com/platform/actors/running/input-and-output"}`
  _possibly related of_ `pr/fetch-apify-docs/mcp-integration-page`: What does the Apify docs page at https://docs.apify.com/platform/integrations/mcp say?
- **pr/fetch-apify-docs/missing-page**
  > open https://docs.apify.com/platform/this-page-does-not-exist for me
  `fetch-apify-docs` or `apify--web-fetch`
  _possibly related of_ `pr/fetch-apify-docs/mcp-integration-page`: What does the Apify docs page at https://docs.apify.com/platform/integrations/mcp say?

### `get-actor-log` — 2 retired, 0 new

⚠️ These assert a tool that no longer exists (renamed `get-actor-run-log`). They could never
pass. Covered now by `pr/get-actor-run-log/*`.

<details><summary>retired wordings</summary>

- Show me the last 20 log lines for Actor run y2h7sK3Wc — I need to see why it failed.
- Show me the log for Actor run y2h7sK3Wc.

</details>


### `get-actor-run` — 1 retired, 2 new

<details><summary>retired wordings</summary>

- What is the status of my Actor run with ID abc123XYZ456?

</details>

- **pr/get-actor-run/lazy-is-it-done**  ← **FAILS**
  > is run oQNzVLE4B1CcjtzhS done yet
  `get-actor-run` · args `{"runId": "oQNzVLE4B1CcjtzhS"}`
  _no v1 equivalent_
- **pr/get-actor-run/wait-until-finished**  ← **FAILS**
  > wait up to 60 seconds for run oQNzVLE4B1CcjtzhS to finish and tell me how it went
  `get-actor-run` · args `{"runId": "oQNzVLE4B1CcjtzhS", "waitSecs": 60}`
  _no v1 equivalent_

### `get-actor-run-list` — 1 retired, 2 new

<details><summary>retired wordings</summary>

- List my last 10 Actor runs, most recent first.

</details>

- **pr/get-actor-run-list/lazy-what-ran-lately**
  > what have i run lately
  `get-actor-run-list`
  _no v1 equivalent_
- **pr/get-actor-run-list/only-failed-ones**
  > show me my failed runs
  `get-actor-run-list` · args `{"status": "FAILED"}`
  _no v1 equivalent_

### `get-actor-run-log` — 0 retired, 3 new

- **pr/get-actor-run-log/error-message-not-status**
  > whats the actual error message in run oQNzVLE4B1CcjtzhS
  `get-actor-run-log` or `get-actor-run`
  _no v1 equivalent_
- **pr/get-actor-run-log/last-50-lines**
  > show me the last 50 log lines of run oQNzVLE4B1CcjtzhS
  `get-actor-run-log` · args `{"lines": 50, "runId": "oQNzVLE4B1CcjtzhS"}`
  _no v1 equivalent_
- **pr/get-actor-run-log/lazy-why-did-it-break**
  > run oQNzVLE4B1CcjtzhS blew up, why
  `get-actor-run-log` or `get-actor-run`
  _no v1 equivalent_

### `get-actor-task` — 2 retired, 2 new

<details><summary>retired wordings</summary>

- What is the configuration of my task insta-daily?
- Is my task insta-daily published?

</details>

- **pr/get-actor-task/is-it-public**
  > is eval-sum-nightly public
  `get-actor-task`
  _no v1 equivalent_
- **pr/get-actor-task/lazy-what-does-it-run**
  > what does my task eval-sum-nightly actually run
  `get-actor-task` · args `{"taskId": "eval-sum-nightly"}`
  _no v1 equivalent_

### `get-dataset` — 3 retired, 2 new

<details><summary>retired wordings</summary>

- What fields does dataset UvsU contain?
- How many items are in dataset abc123?
- Show me the metadata and stats for dataset des32s

</details>

- **pr/get-dataset/lazy-how-many-rows**
  > how many rows are in dataset iSpp2Q3G60uWDLOi0
  `get-dataset` · args `{"datasetId": "iSpp2Q3G60uWDLOi0"}`
  _close equivalent of_ `pr/get-dataset/item-count`: How many items are in dataset abc123?
- **pr/get-dataset/when-created**
  > when was dataset iSpp2Q3G60uWDLOi0 created
  `get-dataset`
  _no v1 equivalent_

### `get-dataset-items` — 7 retired, 4 new

<details><summary>retired wordings</summary>

- Retrieve all results from my web scraper with datasetID abc123
- Get the first 50 items from my datasetId abc123
- Show me the data from my Instagram scraper run with datasetId d23d2
- Get output from my latest actor with datasetId des32s
- Get query and markdown fields from dataset UvsU
- Retrieve results from dataset abc123
- Retrieve only the title and url fields from dataset UvsU

</details>

- **pr/get-dataset-items/lazy-show-data**
  > show me whats in dataset iSpp2Q3G60uWDLOi0
  `get-dataset-items` or `get-dataset`
  _no v1 equivalent_
- **pr/get-dataset-items/newest-first**
  > last 10 entries of dataset iSpp2Q3G60uWDLOi0, newest first
  `get-dataset-items` · args `{"datasetId": "iSpp2Q3G60uWDLOi0", "desc": true, "limit": 10}`
  _no v1 equivalent_
- **pr/get-dataset-items/only-two-fields**
  > from dataset iSpp2Q3G60uWDLOi0 i only need title and url
  `get-dataset-items` · args `{"datasetId": "iSpp2Q3G60uWDLOi0", "fields": "title,url"}`
  _possibly related of_ `pr/get-dataset-items/select-title-url-fields`: Retrieve only the title and url fields from dataset UvsU
- **pr/get-dataset-items/page-two**
  > give me rows 100 to 199 of dataset iSpp2Q3G60uWDLOi0
  `get-dataset-items` · args `{"datasetId": "iSpp2Q3G60uWDLOi0", "limit": 100, "offset": 100}`
  _no v1 equivalent_

### `get-dataset-list` — 3 retired, 2 new

<details><summary>retired wordings</summary>

- What datasets do I have in my account?
- Show me my last 10 datasets, newest first
- List all my datasets

</details>

- **pr/get-dataset-list/include-unnamed**
  > list all my datasets, including the temporary unnamed ones
  `get-dataset-list` · args `{"unnamed": true}`
  _possibly related of_ `pr/get-dataset-list/list-all`: List all my datasets
- **pr/get-dataset-list/lazy-what-data-i-have**
  > what datasets do i have lying around
  `get-dataset-list`
  _close equivalent of_ `pr/get-dataset-list/account-datasets`: What datasets do I have in my account?

### `get-dataset-schema` — 3 retired, 3 new

<details><summary>retired wordings</summary>

- What is the schema of dataset abc123?
- Generate a JSON schema for dataset des32s using 10 items
- Infer the structure of the items in dataset UvsU

</details>

- **pr/get-dataset-schema/from-ten-items**
  > work out the schema of dataset iSpp2Q3G60uWDLOi0 off the first 10 rows
  `get-dataset-schema` · args `{"datasetId": "iSpp2Q3G60uWDLOi0", "limit": 10}`
  _no v1 equivalent_
- **pr/get-dataset-schema/json-schema-for-dataset**
  > i need the json schema for dataset iSpp2Q3G60uWDLOi0
  `get-dataset-schema` · args `{"datasetId": "iSpp2Q3G60uWDLOi0"}`
  _possibly related of_ `pr/get-dataset-schema/generate-from-10-items`: Generate a JSON schema for dataset des32s using 10 items
- **pr/get-dataset-schema/lazy-what-shape**
  > what do the records in dataset iSpp2Q3G60uWDLOi0 look like, field wise
  `get-dataset-schema` or `get-dataset`
  _no v1 equivalent_

### `get-key-value-store` — 2 retired, 2 new

<details><summary>retired wordings</summary>

- Get details about key-value store des32s
- Show me the metadata for key-value store abc123

</details>

- **pr/get-key-value-store/lazy-store-info**
  > tell me about store rMrkxdMEem3a3BGt4
  `get-key-value-store` · args `{"keyValueStoreId": "rMrkxdMEem3a3BGt4"}`
  _no v1 equivalent_
- **pr/get-key-value-store/size-check**
  > how big is key value store rMrkxdMEem3a3BGt4
  `get-key-value-store`
  _no v1 equivalent_

### `get-key-value-store-keys` — 2 retired, 2 new

<details><summary>retired wordings</summary>

- List the keys in key-value store abc123
- What keys are stored in my key-value store des32s?

</details>

- **pr/get-key-value-store-keys/first-five**
  > just the first 5 keys in store rMrkxdMEem3a3BGt4 please
  `get-key-value-store-keys` · args `{"keyValueStoreId": "rMrkxdMEem3a3BGt4", "limit": 5}`
  _no v1 equivalent_
- **pr/get-key-value-store-keys/lazy-whats-in-there**
  > whats saved in store rMrkxdMEem3a3BGt4
  `get-key-value-store-keys` or `get-key-value-store`
  _no v1 equivalent_

### `get-key-value-store-list` — 2 retired, 2 new

<details><summary>retired wordings</summary>

- What key-value stores do I have in my account?
- List all my key-value stores

</details>

- **pr/get-key-value-store-list/include-unnamed**
  > show me every key value store i have, temporary ones included
  `get-key-value-store-list` · args `{"unnamed": true}`
  _no v1 equivalent_
- **pr/get-key-value-store-list/lazy-my-stores**
  > list my key value stores
  `get-key-value-store-list`
  _close equivalent of_ `pr/get-key-value-store-list/list-all`: List all my key-value stores

### `get-key-value-store-record` — 3 retired, 2 new

<details><summary>retired wordings</summary>

- Fetch the contents of key data.json from store UvsU
- Get record INPUT from key-value store abc123
- Read the value under key OUTPUT in key-value store des32s

</details>

- **pr/get-key-value-store-record/input-of-run**
  > what input was used? its in store rMrkxdMEem3a3BGt4 under INPUT
  `get-key-value-store-record` · args `{"keyValueStoreId": "rMrkxdMEem3a3BGt4", "recordKey": "INPUT"}`
  _no v1 equivalent_
- **pr/get-key-value-store-record/lazy-output**
  > get me OUTPUT from store rMrkxdMEem3a3BGt4
  `get-key-value-store-record` · args `{"keyValueStoreId": "rMrkxdMEem3a3BGt4", "recordKey": "OUTPUT"}`
  _no v1 equivalent_

### `get-schedule` — 2 retired, 2 new

<details><summary>retired wordings</summary>

- Add my task eval-sum-nightly to the schedule eval-nightly-sum.
- When will my schedule eval-nightly-sum run next?

</details>

- **pr/get-schedule/lazy-when-next**
  > when does eval-nightly-sum fire next
  `get-schedule` · args `{"scheduleId": "eval-nightly-sum"}`
  _close equivalent of_ `pr/get-schedule/next-run`: When will my schedule eval-nightly-sum run next?
- **pr/get-schedule/read-before-replacing-actions**
  > add my task eval-sum-nightly to the eval-nightly-sum schedule as well
  `get-schedule`
  _close equivalent of_ `pr/get-schedule/add-action-reads-first`: Add my task eval-sum-nightly to the schedule eval-nightly-sum.

### `publish-actor-task` — 3 retired, 2 new

<details><summary>retired wordings</summary>

- Publish my task insta-daily
- Make my task insta-daily public
- I now have write access to my task insta-daily and its Actor now — publish it.

</details>

- **pr/publish-actor-task/lazy-make-public**
  > put eval-sum-nightly up on the actors public page
  `publish-actor-task` or `get-actor-task`
  _no v1 equivalent_
- **pr/publish-actor-task/let-people-find-it**
  > i want other people to be able to find eval-sum-nightly
  `publish-actor-task` or `get-actor-task`
  _no v1 equivalent_

### `report-problem` — 0 retired, 1 new

- **pr/report-problem/broken-tool-complaint**  ← **FAILS**
  > your call-actor tool keeps erroring out, tell someone about it
  `report-problem`
  _no v1 equivalent_

### `search-actors` — 27 retired, 4 new

<details><summary>retired wordings</summary>

- I need to find solution to scrape details of Amazon products
- Show me Amazon product scrapers
- Find actors for data extraction tasks
- What tools can extract data from e-commerce sites?
- Find an Actor to get Facebook data
- Find an Actor that scrapes flight data from booking sites
- Find actors for flight data extraction
- Find posts about AI on Instagram
- What Actors can scrape Instagram posts?
- Scrape Instagram posts about AI
- Find an Actor to get instagram posts
- Find posts about the Rock on Instagram
- I need to find Actor for instagram profile scraping
- What are the best Instagram scrapers?
- Find actors that can scrape news articles
- Find an Actor that can automate a headless browser using Playwright.
- Find an Actor to get flight information from Skyscanner
- Find actors for scraping social media
- Use Apify to scrape StackOverflow for the top 10 most upvoted quicksort implementations in Python
- I'm new to Apify, I can't really code, I need data from my project, I need tiktok comments. I'm also price sensitive
- What actors can scrape TikTok content?
- What is the best TikTok scraper on Apify?
- Find an Actor to fetch posts from Twitter about AI
- Show me Twitter scraping tools
- I want to scrape LinkedIn profiles but I don't know which Actor to use for that.
- Can you find actors to scrape weather data?
- Search for weather data scraping tools

</details>

- **pr/search-actors/lazy-linkedin-jobs-typo**
  > smth that can scrape linkedn job postings?
  `search-actors`
  _no v1 equivalent_
- **pr/search-actors/lazy-tiktok-comments-need**
  > need tiktok comments for a project, no clue where to start
  `search-actors`
  _no v1 equivalent_
- **pr/search-actors/limit-three-amazon-reviews**  ← **FAILS**
  > give me just 3 options for scraping amazon reviews
  `search-actors` · args `{"limit": 3}`
  _no v1 equivalent_
- **pr/search-actors/tool-not-data-maps-reviews**
  > i need something i can run every week to pull google maps reviews
  `search-actors`
  _no v1 equivalent_

### `search-apify-docs` — 10 retired, 3 new

<details><summary>retired wordings</summary>

- Show me Apify Actor documentation
- Search the Apify docs for the API integration guide
- How to use Apify Proxy
- How do I build my own Apify Actor from scratch?
- How to build an Apify Actor
- How to do web scraping with Crawlee in the Apify docs
- Error handling in Actors
- Ho to define Actor input schema, provide examples
- Is there documentation for the Apify MCP server?
- How to use Playwright library with Apify

</details>

- **pr/search-apify-docs/lazy-how-proxy-works**
  > how does apify proxy work
  `search-apify-docs`
  _close equivalent of_ `pr/search-apify-docs/apify-proxy-usage`: How to use Apify Proxy
- **pr/search-apify-docs/lazy-webhooks-setup**
  > how do i set up webhooks on apify
  `search-apify-docs`
  _possibly related of_ `pr/search-apify-docs/apify-proxy-usage`: How to use Apify Proxy
- **pr/search-apify-docs/vs-web-search-standby**
  > docs on actor standby mode
  `search-apify-docs`
  _no v1 equivalent_

### `unpublish-actor-task` — 2 retired, 2 new

<details><summary>retired wordings</summary>

- Unpublish my task insta-daily
- Take my task insta-daily off its public page but keep its display settings

</details>

- **pr/unpublish-actor-task/hide-not-delete**
  > hide eval-sum-nightly from the public but dont delete it
  `unpublish-actor-task` or `get-actor-task`
  _no v1 equivalent_
- **pr/unpublish-actor-task/lazy-take-down**
  > take eval-sum-nightly off the public page
  `unpublish-actor-task` or `get-actor-task`
  _possibly related of_ `pr/unpublish-actor-task/insta-daily-keep-display-settings`: Take my task insta-daily off its public page but keep its display settings

### `update-actor-task` — 5 retired, 3 new

<details><summary>retired wordings</summary>

- Set up my task insta-daily's public page with the query input field and the overview dataset view before I publish it.
- Change my task insta-daily to use the beta build
- I already have a task called insta-daily, change its input to search for cats instead
- Set the landing page title of my task insta-daily to 'Daily Instagram scraper'
- Set up my task insta-daily for publishing, using the overview dataset view

</details>

- **pr/update-actor-task/landing-page-title**
  > the public page title for eval-sum-nightly should say Nightly sum
  `update-actor-task` or `get-actor-task`
  _no v1 equivalent_
- **pr/update-actor-task/lazy-change-numbers**
  > change my task eval-sum-nightly to add 10 and 20 instead
  `update-actor-task` or `get-actor-task`
  _no v1 equivalent_
- **pr/update-actor-task/switch-build**
  > point task eval-sum-nightly at the test build
  `update-actor-task` or `get-actor-task`
  _no v1 equivalent_

### `update-schedule` — 3 retired, 3 new

<details><summary>retired wordings</summary>

- Change my schedule eval-nightly-sum to run every 6 hours.
- Pause my schedule eval-nightly-sum.
- Turn my schedule eval-nightly-sum back on.

</details>

- **pr/update-schedule/change-frequency**  ← **FAILS**
  > make eval-nightly-sum run every 6 hours instead
  `update-schedule` or `get-schedule`
  _close equivalent of_ `pr/update-schedule/every-6-hours`: Change my schedule eval-nightly-sum to run every 6 hours.
- **pr/update-schedule/lazy-pause**
  > pause eval-nightly-sum for now
  `update-schedule` or `get-schedule`
  _close equivalent of_ `pr/update-schedule/pause`: Pause my schedule eval-nightly-sum.
- **pr/update-schedule/turn-back-on**
  > turn eval-nightly-sum back on
  `update-schedule` or `get-schedule`
  _close equivalent of_ `pr/update-schedule/resume`: Turn my schedule eval-nightly-sum back on.

## merge tier, by family

Families were reorganised, so old and new names do not line up one to one:

- retired: `mcp-agent` (30), `schedules` (10), `tasks` (10), `web-fetch` (11), `web-selection` (9)
- new: `actors` (4), `dev` (1), `docs` (2), `runs` (4), `schedules` (6), `storage` (6), `tasks` (5), `web` (9)

### `merge/actors/*` — 4 cases

- **merge/actors/cost-and-input-before-running** (10 turns)
  > before i run anything - whats apidojo/tweet-scraper going to cost me and what do i actually have to give it as input
  PASS/FAIL: PASS only if fetch-actor-details was called for apidojo/tweet-scraper and the final answer states both a pricing fact and at least one concrete input field from the Actor's schema. FAIL if the agent runs the Actor, or answers from memory without any tool call.
  _no v1 equivalent_

- **merge/actors/nonexistent-actor-graceful** (8 turns; errors allowed: fetch-actor-details)
  > whats apify/totally-made-up-actor-xyz do
  PASS/FAIL: PASS only if the agent attempted to look the Actor up with a tool and then told the user plainly that it does not exist. FAIL if it fabricates a description, or silently answers about a different Actor without saying it substituted one.
  _no v1 equivalent_

- **merge/actors/run-and-report-output** (12 turns)
  > i want to try apifys hello world actor, just run it and tell me what comes out
  PASS/FAIL: PASS only if call-actor was called for apify/hello-world and the final answer reports the Actor's actual output text (the 'Hello world!' message). The agent may obtain it from the run result, the run's dataset, or its key-value store - any of those is fine. FAIL if the answer states an output that no tool call returned, or if the agent claims it cannot run Actors.
  _no v1 equivalent_

- **merge/actors/vague-need-shortlist** (12 turns)
  > need to get reviews off google maps, cheap as possible, i cant code
  PASS/FAIL: PASS only if search-actors was called and the final answer recommends at least two named Actors with something about their cost or ease of use. The judge cannot see tool results, so do NOT penalise slugs or figures for looking too specific - assume anything the agent reports after a successful search came from it. FAIL only if search-actors was never called, or the agent asked a clarifying question instead of searching.
  _no v1 equivalent_

### `merge/dev/*` — 1 cases

- **merge/dev/report-after-failure** (8 turns; forced failures: call-actor)  ← **FAILS**
  > use the apify/website-content-crawler actor to pull https://docs.apify.com/platform and summarise it for me
  PASS/FAIL: PASS only if, after the Actor call failed, the agent BOTH told the user it could not complete the task AND called report-problem about that failure without being asked to. FAIL if it answered from memory as though the tool had worked, or never reported the problem.
  _possibly related of_ `merge/mcp-agent/report-problem-on-tool-error`: Use the apify/rag-web-browser Actor to scrape https://example.com and tell me the page title.

### `merge/docs/*` — 2 cases

- **merge/docs/how-do-i-with-citation** (12 turns)  ← **FAILS**
  > how do i make an actor run on a schedule from the api? link me the docs
  PASS/FAIL: PASS only if search-apify-docs was called and the final answer both answers the question and cites at least one docs.apify.com URL. The judge cannot see tool results, so do NOT penalise a URL for looking specific or for not being verifiable - assume any docs.apify.com link the agent gives after a successful search came from that search. FAIL only if no docs tool was called, or the answer cites nothing.
  _no v1 equivalent_

- **merge/docs/search-then-read-page** (12 turns)
  > whats the difference between actor standby and a normal run, according to the docs
  PASS/FAIL: PASS only if the agent searched the Apify docs and then fetched at least one docs page before answering, and the final answer describes the difference between standby and a normal run. FAIL if the agent answers from memory with no tool call, or claims to have read a page it never fetched.
  _no v1 equivalent_

### `merge/runs/*` — 4 cases

- **merge/runs/any-failures-recently** (8 turns)
  > anything of mine failed recently?
  PASS/FAIL: PASS only if the run list was fetched filtered to failed runs (a FAILED status filter) and the final answer either names the failed runs or states plainly that there are none. Listing every run and leaving the user to work it out is a FAIL, as is inventing run ids.
  _no v1 equivalent_

- **merge/runs/last-run-status-lazy** (10 turns)  ← **FAILS**
  > did my last run finish ok?
  PASS/FAIL: PASS only if the agent listed the user's runs with a tool to find the most recent one, and the final answer states that run's status and which Actor it belonged to. FAIL if the agent asks the user for a run id instead of listing runs, or states a status it never read from a tool result.
  _no v1 equivalent_

- **merge/runs/log-not-just-status** (10 turns)
  > show me what my last run actually logged, not just the status
  PASS/FAIL: PASS only if get-actor-run-log was called for the most recent run and the final answer quotes or summarises real log content from that result. FAIL if the agent reports only the run status, or claims logs are unavailable without calling the log tool.
  _no v1 equivalent_

- **merge/runs/start-then-abort** (14 turns; errors allowed: abort-actor-run)
  > start apify/rag-web-browser searching for 'apify mcp server' and then actually never mind, kill it straight away
  PASS/FAIL: PASS only if the run was started and abort-actor-run was then called with that same run's id. If the run had already finished before the abort landed, reporting that truthfully is also a PASS. FAIL if the agent claims to have aborted the run without calling abort-actor-run, or aborts a different run id than the one it started.
  _no v1 equivalent_

### `merge/schedules/*` — 6 cases

- **merge/schedules/add-keep-existing** (12 turns)
  > also run apify/hello-world on the eval-sched-target schedule, keep whatever is already on it
  PASS/FAIL: PASS only if the agent read eval-sched-target first and then updated it with an actions list containing BOTH the action it already had AND the new apify/hello-world action. FAIL if the update sends only the new action, dropping the existing one.
  _possibly related of_ `merge/schedules/add-action-medium-1`: My schedule eval-sched-target should also run apify/hello-world every time it fires, keeping whatever it already runs. Set that up and then tell me everything it runs now.

- **merge/schedules/create-then-remove** (12 turns)
  > set up apify/hello-world to run daily at 4am, name it eval-sched-temp - actually, delete it again once its made, i just want to see that it works
  PASS/FAIL: PASS only if create-schedule created eval-sched-temp and delete-schedule then removed it, with the final answer confirming both steps. FAIL if the schedule is left in place, or merely disabled instead of deleted.
  _no v1 equivalent_

- **merge/schedules/name-collision** (10 turns; errors allowed: create-schedule)
  > set up a schedule called eval-nightly-sum that runs my task eval-sum-nightly every day at 3am utc
  PASS/FAIL: A schedule named eval-nightly-sum already exists, so create-schedule must fail with a name-not-unique error. PASS only if the agent attempted the create, and then told the user plainly that a schedule with that name already exists - it may stop and ask how to proceed, or propose a different name. FAIL if it silently picks another name and reports success as though the requested name was used, or claims the schedule was created.
  _close equivalent of_ `merge/schedules/collision-hard-1`: Create a schedule called eval-nightly-sum that runs my task eval-sum-nightly every day at 3:00 UTC.

- **merge/schedules/not-found-honest** (6 turns; errors allowed: get-schedule)
  > when does my eval-sched-does-not-exist schedule run next
  PASS/FAIL: PASS only if the agent looked the schedule up with a tool and then told the user it does not exist. FAIL if it invents a next-run time, or reports on a different schedule without saying it substituted one.
  _no v1 equivalent_

- **merge/schedules/pause-not-delete** (8 turns)
  > stop eval-nightly-sum from firing for a while, im debugging something
  PASS/FAIL: PASS if the agent ended with the schedule eval-nightly-sum not firing AND said so: either it called update-schedule to disable it, or it read the schedule, found it already disabled, and reported that plainly. FAIL if delete-schedule was called, or if the agent neither changed nor reported the schedule's enabled state.
  _no v1 equivalent_

- **merge/schedules/weekday-morning-prague** (10 turns)
  > run eval-sum-nightly every weekday at 7:30 prague time, name it eval-sched-weekday
  PASS/FAIL: PASS only if create-schedule created a schedule named eval-sched-weekday that targets the eval-sum-nightly task and fires at 07:30 on Monday to Friday only, with the Prague time zone set (or the hour correctly converted to UTC). FAIL if the cron fires all seven days, or if the time is left at 7:30 UTC with no time zone set.
  _no v1 equivalent_

### `merge/storage/*` — 6 cases

- **merge/storage/all-rows-one-call** (16 turns)  ← **FAILS**
  > search the web with apify for 'apify mcp server' and give me 5 results, then pull all of them back in one go and tell me how many you got
  PASS/FAIL: PASS only if the Actor was run, get-dataset-items was then called with that run's datasetId in a SINGLE call carrying an explicit limit of at least the number of results requested (a limit equal to the requested count is sufficient and should PASS), and the final answer states how many rows came back. FAIL if get-dataset-items was called repeatedly to page through the dataset, if no explicit limit was passed at all, or if the reported count came from nowhere.
  _no v1 equivalent_

- **merge/storage/count-lag-honesty** (10 turns)
  > how many items are in my newest dataset
  PASS/FAIL: PASS only if the agent read the dataset's item count with a tool and the final answer reports the count it read. A reported count of zero is NOT a failure, and an agent noting that a freshly written count can lag behind the items is a good answer, not an admission of error. FAIL only if the agent states a count that no tool result returned.
  _no v1 equivalent_

- **merge/storage/dig-out-a-run-input** (14 turns)  ← **FAILS**
  > i need the input that was used for one of my recent runs, dig it out for me
  PASS/FAIL: PASS only if the agent located a recent run, then read that run's key-value store - listing its keys and/or reading the INPUT record - and reported input values that came from the tool result. FAIL if the agent reports an input it never read, or gives up without attempting the key-value store tools.
  _no v1 equivalent_

- **merge/storage/run-then-pick-fields** (16 turns)
  > run apify/rag-web-browser for 'what is the apify mcp server', i only want the page titles and urls out of it
  PASS/FAIL: PASS only if the Actor was run and get-dataset-items was then called with that run's datasetId AND a fields selection naming the title and url fields, and the final answer lists titles with their urls. FAIL if the agent fetches every field and narrows only in its own prose, or reports results without calling get-dataset-items.
  _no v1 equivalent_

- **merge/storage/shape-without-dumping** (12 turns)  ← **FAILS**
  > whats the structure of the data in my newest dataset? dont dump the whole thing on me
  PASS/FAIL: PASS only if the agent found a dataset via a list tool and then described its field structure using the dataset schema or dataset metadata tool, without pulling the full item contents. FAIL if it fetches all items to infer the shape while a schema tool was available, or names fields no tool result contained.
  _no v1 equivalent_

- **merge/storage/what-data-do-i-have** (10 turns)
  > what data do i have sitting on apify
  PASS/FAIL: PASS only if the agent listed the account's storages with a tool (datasets and/or key-value stores) and the final answer summarises what came back. FAIL if the agent asks which storage the user means without listing anything first, or names storages that no tool result contained.
  _no v1 equivalent_

### `merge/tasks/*` — 5 cases

- **merge/tasks/change-stored-input** (10 turns)  ← **FAILS**
  > my eval-sum-nightly task should add 100 and 200 from now on
  PASS/FAIL: PASS only if update-actor-task was called for the existing eval-sum-nightly task with an input carrying 100 and 200, and the final answer confirms the change. FAIL if a new task was created instead of updating the existing one.
  _no v1 equivalent_

- **merge/tasks/name-collision** (12 turns; errors allowed: create-actor-task)
  > make me a task called eval-sum-hourly for apify/normal-mode-test-actor adding 3 and 4. then make another one, same name, same actor, adding 7 and 8. tell me exactly what happened with each
  PASS/FAIL: Task names are unique per account, so the second create must fail with a name conflict. PASS only if the first create succeeded, a second create with the same name was attempted and failed, and the final answer states plainly that the first was created and the second was rejected because the name is taken. FAIL if the agent silently renames the second task, or reports both as created.
  _close equivalent of_ `merge/tasks/create-collision`: Create a task named eval-sum-hourly for apify/normal-mode-test-actor with firstNumber 3 and secondNumber 4. Then create a second task, also named eval-sum-hourly, for the same Actor, with firstNumber 7 and secondNumber 8. Tell me exactly what happened with each.

- **merge/tasks/publish-requirement-discovery** (16 turns; errors allowed: publish-actor-task)  ← **FAILS**
  > put eval-sum-nightly up on its actors public page so people can see what it does
  PASS/FAIL: PASS if the task ends up published, by whichever route: attempting the publish, reading the missing requirements out of the error and filling them in, OR setting the requirements up front and publishing in one pass. If publishing could not be completed, PASS only if the agent names the specific requirement still missing. FAIL if the agent stops at the first error without acting on what it named, or claims the task is published without a successful publish call.
  _no v1 equivalent_

- **merge/tasks/save-my-setup** (10 turns)
  > i keep rerunning apify/normal-mode-test-actor with 8 and 9, save that so i dont have to retype it. call it eval-sum-eight-nine
  PASS/FAIL: PASS only if create-actor-task created a task named eval-sum-eight-nine for apify/normal-mode-test-actor whose stored input carries the numbers 8 and 9, and the final answer confirms it was saved. FAIL if a schedule was created instead of a task, or success is claimed without a successful create call.
  _no v1 equivalent_

- **merge/tasks/save-publish-check-remove** (18 turns; errors allowed: publish-actor-task)
  > make a one-click version of apify/normal-mode-test-actor called eval-nmta-cycle that adds 2 and 3, put it up publicly, check its actually live, then take it back down
  PASS/FAIL: PASS only if a task named eval-nmta-cycle was created for apify/normal-mode-test-actor, published, its published state then confirmed by reading the task back, and finally unpublished - with the final answer reporting all four steps. FAIL if any of the four is claimed without its tool call succeeding. If publishing cannot be completed because a requirement could not be met, saying so plainly and stopping there is also a PASS.
  _no v1 equivalent_

### `merge/web/*` — 9 cases

- **merge/web/escalate-when-blocked** (14 turns; errors allowed: apify--rag-web-browser)
  > read https://www.reddit.com/r/webscraping/ and tell me the top post titles
  PASS/FAIL: PASS if the page content was retrieved and real post titles reported, by whichever route worked. If the first attempt came back blocked, empty or errored, the agent must have escalated to the dedicated single-URL fetch tool rather than giving up. A truthful report that the page could not be retrieved after trying both routes is also a PASS. FAIL if the agent reports titles it never retrieved.
  _possibly related of_ `merge/web-selection/rag-blocked`: Use Apify's web browser to read https://www.reddit.com/r/webscraping/ for me and tell me what's being discussed there.

- **merge/web/list-the-links** (12 turns)
  > list every link on https://example.com for me
  PASS/FAIL: PASS only if the fetch tool was called for https://example.com and the final answer lists the link(s) found on it. Requesting the 'links' output format is the direct path; extracting links from fetched page content is equally acceptable. FAIL if links are reported without any fetch, or the agent claims it cannot extract links.
  _close equivalent of_ `merge/web-fetch/links-medium-1`: Using Apify, list every link that appears on https://example.com.

- **merge/web/markup-not-cleaned-up** (12 turns)
  > i need the actual html source of https://example.com, not a tidied up version
  PASS/FAIL: The user asked for the page's markup, so the fetch must request a markup-preserving output format - 'html' or 'raw' both satisfy this. PASS only if the fetch tool was called for https://example.com with such a format and the final answer shows the markup. FAIL if the page was returned only as markdown or plain text, or if no fetch was made.
  _close equivalent of_ `merge/web-fetch/formats-easy-1`: With Apify, get me the HTML source of https://example.com - the actual markup, not a cleaned-up version.

- **merge/web/pdf-to-text** (12 turns)
  > whats actually written in this pdf https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf
  PASS/FAIL: The fetch Actor converts PDFs to Markdown. PASS only if the fetch tool was called with that PDF url, the output was retrieved, and the final answer states the PDF's actual text. FAIL if the agent says it cannot read PDFs without trying, or reports text it did not retrieve.
  _close equivalent of_ `merge/web-fetch/formats-medium-1`: Use Apify to read this PDF and tell me exactly what text it contains: https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf

- **merge/web/query-not-a-url** (12 turns)
  > whats the general consensus online about apify vs scrapy
  PASS/FAIL: PASS only if the agent ran a web search by query rather than fetching a single guessed URL, and the final answer summarises what several sources said. FAIL if the agent invents a specific URL and fetches that instead of searching.
  _no v1 equivalent_

- **merge/web/reports-404-truthfully** (12 turns)
  > grab https://www.rfc-editor.org/rfc/rfc99999.txt and tell me exactly what came back
  PASS/FAIL: That URL returns HTTP 404. The fetch run itself still succeeds and records the status code. PASS only if the fetch tool was called with that url and the final answer reports that the page was not found / returned 404. FAIL if the agent presents unrelated content as though it were that page, or claims success without naming the error status.
  _no v1 equivalent_

- **merge/web/unreachable-host** (12 turns; errors allowed: apify--web-fetch)
  > whats on https://this-domain-definitely-does-not-exist-9x7q2.com
  PASS/FAIL: The domain does not resolve. Depending on routing the run either fails with a connection error or succeeds with an empty item carrying a proxy error - both mean the same thing. PASS only if the agent attempted the fetch and then told the user the site could not be reached. FAIL if it invents content, or silently substitutes a different domain.
  _possibly related of_ `merge/web-fetch/unreachable`: Use Apify to get the content of https://this-domain-definitely-does-not-exist-9x7q2.com and tell me what's on it.

- **merge/web/unsupported-scheme-honesty** (12 turns; errors allowed: apify--web-fetch)
  > grab ftp://ftp.rfc-editor.org/in-notes/rfc9110.txt for me
  PASS/FAIL: PASS only if the final answer tells the user that the ftp:// scheme is not supported by the fetch tool. Quietly rewriting the address to https:// and presenting that result as the requested fetch is a FAIL, even when the content returned is correct.
  _no v1 equivalent_

- **merge/web/verbatim-single-url** (16 turns; errors allowed: call-actor)  ← **FAILS**
  > pull up https://www.rfc-editor.org/rfc/rfc9110.html and tell me what it says about the GET method, in its own words not yours
  PASS/FAIL: PASS only if that exact URL was fetched with a tool and the final answer conveys what the document says about the GET method, drawing on the fetched content. The page is long, so a partial or summarised account of the GET section is fine as long as it plainly came from the fetch. FAIL if a different URL was fetched, if the answer is delivered from memory with no successful fetch, or if the agent never gives a final answer at all.
  _no v1 equivalent_


## Retired cases and their successors

The reverse view. A retired case with no successor was a duplicate of another wording, or was
consolidated - its tool is still covered. Check `../mcp_tool_coverage_evals.md` if a gap looks real.

### Retired with a successor (28)

- `merge/mcp-agent/report-problem-on-tool-error` → `merge/dev/report-after-failure`
  > Use the apify/rag-web-browser Actor to scrape https://example.com and tell me the page title.
- `merge/schedules/add-action-medium-1` → `merge/schedules/add-keep-existing`
  > My schedule eval-sched-target should also run apify/hello-world every time it fires, keeping whateve
- `merge/schedules/collision-hard-1` → `merge/schedules/name-collision`
  > Create a schedule called eval-nightly-sum that runs my task eval-sum-nightly every day at 3:00 UTC.
- `merge/tasks/create-collision` → `merge/tasks/name-collision`
  > Create a task named eval-sum-hourly for apify/normal-mode-test-actor with firstNumber 3 and secondNu
- `merge/web-fetch/formats-easy-1` → `merge/web/markup-not-cleaned-up`
  > With Apify, get me the HTML source of https://example.com - the actual markup, not a cleaned-up vers
- `merge/web-fetch/formats-medium-1` → `merge/web/pdf-to-text`
  > Use Apify to read this PDF and tell me exactly what text it contains: https://www.w3.org/WAI/ER/test
- `merge/web-fetch/links-medium-1` → `merge/web/list-the-links`
  > Using Apify, list every link that appears on https://example.com.
- `merge/web-fetch/unreachable` → `merge/web/unreachable-host`
  > Use Apify to get the content of https://this-domain-definitely-does-not-exist-9x7q2.com and tell me 
- `merge/web-selection/rag-blocked` → `merge/web/escalate-when-blocked`
  > Use Apify's web browser to read https://www.reddit.com/r/webscraping/ for me and tell me what's bein
- `pr/call-actor/hashtag-research-ai` → `pr/call-actor/lazy-just-run-hello`
  > Run apify/social-media-hashtag-research for #AI
- `pr/create-schedule/task-daily-prague` → `pr/create-schedule/lazy-every-morning`, `pr/create-schedule/timezone-prague`
  > I already have a task called eval-sum-nightly. Schedule it to run every day at 9:00 Prague time.
- `pr/delete-schedule/remove` → `pr/delete-schedule/remove-completely-not-pause`
  > Delete my schedule eval-nightly-sum, I don't need it anymore.
- `pr/fetch-actor-details/google-search-scraper` → `pr/fetch-actor-details/lazy-what-input-needed`
  > Scrape details of apify/google-search-scraper
- `pr/fetch-actor-details/instagram-scraper-capabilities` → `pr/fetch-actor-details/lazy-whats-it-about`
  > What can apify/instagram-scraper do?
- `pr/fetch-apify-docs/mcp-integration-page` → `pr/fetch-apify-docs/explicit-url-page`, `pr/fetch-apify-docs/missing-page`
  > What does the Apify docs page at https://docs.apify.com/platform/integrations/mcp say?
- `pr/get-dataset-items/select-title-url-fields` → `pr/get-dataset-items/only-two-fields`
  > Retrieve only the title and url fields from dataset UvsU
- `pr/get-dataset-list/account-datasets` → `pr/get-dataset-list/lazy-what-data-i-have`
  > What datasets do I have in my account?
- `pr/get-dataset-list/list-all` → `pr/get-dataset-list/include-unnamed`
  > List all my datasets
- `pr/get-dataset-schema/generate-from-10-items` → `pr/get-dataset-schema/json-schema-for-dataset`
  > Generate a JSON schema for dataset des32s using 10 items
- `pr/get-dataset/item-count` → `pr/get-dataset/lazy-how-many-rows`
  > How many items are in dataset abc123?
- `pr/get-key-value-store-list/list-all` → `pr/get-key-value-store-list/lazy-my-stores`
  > List all my key-value stores
- `pr/get-schedule/add-action-reads-first` → `pr/get-schedule/read-before-replacing-actions`, `pr/delete-schedule/lazy-get-rid-of-it`
  > Add my task eval-sum-nightly to the schedule eval-nightly-sum.
- `pr/get-schedule/next-run` → `pr/get-schedule/lazy-when-next`
  > When will my schedule eval-nightly-sum run next?
- `pr/search-apify-docs/apify-proxy-usage` → `pr/search-apify-docs/lazy-how-proxy-works`, `pr/search-apify-docs/lazy-webhooks-setup`
  > How to use Apify Proxy
- `pr/unpublish-actor-task/insta-daily-keep-display-settings` → `pr/unpublish-actor-task/lazy-take-down`
  > Take my task insta-daily off its public page but keep its display settings
- `pr/update-schedule/every-6-hours` → `pr/update-schedule/change-frequency`
  > Change my schedule eval-nightly-sum to run every 6 hours.
- `pr/update-schedule/pause` → `pr/update-schedule/lazy-pause`
  > Pause my schedule eval-nightly-sum.
- `pr/update-schedule/resume` → `pr/update-schedule/turn-back-on`
  > Turn my schedule eval-nightly-sum back on.

### Retired with no direct successor (167)

Grouped by the tool they asserted, with how many new cases now cover that tool.

**`abort-actor-run`** (1 retired) — 2 new case(s) assert this tool

- `pr/abort-actor-run/stuck-run` — My Actor run y2h7sK3Wc is definitely stuck — I've already checked, it's been running for hours 

**`apify--rag-web-browser`** (13 retired) — 3 new case(s) assert this tool

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
- `pr/call-actor/rag-web-browser` — Use the RAG web browser Actor (apify/rag-web-browser) to search the web for 'latest news on AI 

**`apify--web-fetch`** (1 retired) — 4 new case(s) assert this tool

- `pr/web-fetch/example-com` — Fetch https://example.com and tell me what it says.

**`call`** (5 retired)

- `merge/mcp-agent/call-google-maps-restaurants` — Find the top 3 restaurants in Prague using the Google Maps Scraper, I want to know their names,
- `merge/mcp-agent/call-tiktok-scraper` — Show me 1 latest post from natgeo tik tok using Apify
- `merge/mcp-agent/instagram-posts` — Show me 1 latest post from the natgeo instagram profile
- `merge/mcp-agent/search-add-call-python-actor` — Find example Python Actor and call it with random sample input and present the results
- `merge/mcp-agent/workflow-search-fetch-schema-call` — Find a TikTok scraper, check what input it needs, and run it to get 5 videos from user @example

**`call-actor`** (5 retired) — 4 new case(s) assert this tool

- `pr/call-actor/ecommerce-scraper-iphone` — Scrape iPhone15 at Amazon using apify/e-commerce-scraping-tool
- `pr/call-actor/google-search-restaurants` — Call apify/google-search-scraper to find restaurants in London
- `pr/call-actor/instagram-scraper-hashtag` — Run apify/instagram-scraper to scrape #dwaynejohnson
- `pr/call-actor/tweet-scraper-profiles` — Run apidojo/tweet-scraper to scrape twitter profiles
- `pr/call-actor/weather-scraper-nyc` — Call epctex/weather-scraper for New York

**`chain`** (4 retired)

- `merge/tasks/chain-hard-1` — I keep running apify/normal-mode-test-actor with the same two numbers, 8 and 9, over and over. 
- `merge/tasks/chain-medium-1` — Set up the Google Maps scraper to search for hotels in Prague and save that configuration under
- `merge/web-fetch/chain-hard-1` — With Apify, find out where the link on https://example.com leads, then fetch that page too and 
- `merge/web-selection/chain-medium-1` — Use Apify to double-check where the official Crawlee website lives - search the web rather than

**`create`** (1 retired)

- `merge/tasks/create-easy-1` — Create a task called eval-sum-daily for the apify/normal-mode-test-actor Actor that runs it wit

**`create-actor-task`** (3 retired) — 3 new case(s) assert this tool

- `pr/create-actor-task/google-search-pizza` — Create a task for apify/google-search-scraper that searches for pizza — just create it directly
- `pr/create-actor-task/instagram-insta-daily` — Create a task called insta-daily that runs apify/instagram-scraper — just create it directly.
- `pr/create-actor-task/not-a-schedule` — Save apify/hello-world with the input message 'hi there' as a reusable task named eval-hello-co

**`create-schedule`** (6 retired) — 4 new case(s) assert this tool

- `merge/schedules/chain-medium-1` — Set up a schedule eval-sched-weekly for apify/hello-world with the input message 'weekly ping',
- `merge/schedules/create-easy-1` — Create a schedule named eval-sched-daily that runs my task eval-sum-nightly every day at 9:00 P
- `merge/schedules/cron-hard-1` — I want my task eval-sum-nightly to run on weekdays at half past seven in the morning, New York 
- `merge/schedules/loose-actor-hard-1` — Schedule the Apify hello world actor to run every hour. Call the schedule eval-sched-hourly and
- `pr/create-schedule/actor-weekly-monday` — Schedule apify/hello-world to run every Monday at 8:00 UTC with the input {"message": "weekly p
- `pr/create-schedule/paused` — Create a schedule eval-sched-paused that runs my task eval-sum-nightly every hour, but keep it 

**`delete-schedule`** (1 retired) — 2 new case(s) assert this tool

- `merge/schedules/delete-hard-1` — Create a schedule eval-sched-temp that runs my task eval-sum-nightly daily at noon UTC and keep

**`discovery`** (2 retired)

- `merge/web-selection/discovery-easy-1` — Use Apify to find me a ready-made tool that can scrape TikTok - give me a couple of options wit
- `merge/web-selection/structured-hard-1` — Use Apify to get the 3 most recent posts from the public Instagram profile instagram.com/instag

**`fetch`** (7 retired)

- `merge/mcp-agent/fetch-details-non-mcp-actor-graceful` — Show me MCP tools for apify/instagram-scraper
- `merge/web-fetch/fetch-easy-1` — Use Apify to fetch https://example.com and tell me what the page says.
- `merge/web-fetch/fetch-easy-2` — Use Apify to fetch https://www.rfc-editor.org/rfc/rfc2606.html and tell me which RFC that page 
- `merge/web-fetch/unsupported-protocol` — Use Apify to download ftp://ftp.gnu.org/gnu/annual-report-2026.txt and show me what's in it.
- `merge/web-selection/blocked-native` — Can you get me the content of https://www.reddit.com/r/webscraping/ - the sub's description and
- `merge/web-selection/fetch-easy-1` — Use Apify to open https://crawlee.dev and give me the full homepage content as Markdown - the w
- `merge/web-selection/fetch-medium-1` — Fetch https://www.rfc-editor.org/rfc/rfc2606.html and give me the exact, word-for-word text of 

**`fetch-actor-details`** (10 retired) — 10 new case(s) assert this tool

- `pr/fetch-actor-details/hashtag-research-features` — Tell me about apify/social-media-hashtag-research features
- `pr/fetch-actor-details/input-schema` — Show me the input schema for apify/rag-web-browser
- `pr/fetch-actor-details/instagram-scraper-overview` — What are the details of apify/instagram-scraper?
- `pr/fetch-actor-details/instagram-scraper-parameters` — What parameters does apify/instagram-scraper accept?
- `pr/fetch-actor-details/instagram-scraper-pricing` — How much does apify/instagram-scraper cost?
- `pr/fetch-actor-details/nonexistent-actor` — What does apify/totally-made-up-actor-xyz do?
- `pr/fetch-actor-details/rag-web-browser-docs` — Give me the documentation for apify/rag-web-browser
- `pr/fetch-actor-details/rag-web-browser-how-it-works` — How does apify/rag-web-browser work?
- `pr/fetch-actor-details/rag-web-browser-pricing` — What's the pricing model for apify/rag-web-browser?
- `pr/fetch-actor-details/typo-actor-name` — What can apify/instagarm-scraper do?

**`fetch-apify-docs`** (1 retired) — 2 new case(s) assert this tool

- `pr/fetch-apify-docs/nonexistent-page` — Check the Apify docs for this page: https://docs.apify.com/nonexistent-page

**`formats`** (1 retired)

- `merge/web-fetch/format-discovery` — Using Apify, fetch https://httpbin.org/headers as plain text, sending an Accept-Language header

**`get`** (2 retired)

- `merge/tasks/get-easy-1` — What Actor does my task eval-sum-nightly run, and what input is it configured with?
- `merge/tasks/get-not-found` — What Actor does my task eval-video-digest run?

**`get-actor-log`** (2 retired)

- `pr/get-actor-log/debug-failed-run` — Show me the last 20 log lines for Actor run y2h7sK3Wc — I need to see why it failed.
- `pr/get-actor-log/missing-line-count` — Show me the log for Actor run y2h7sK3Wc.

**`get-actor-run`** (1 retired) — 6 new case(s) assert this tool

- `pr/get-actor-run/status` — What is the status of my Actor run with ID abc123XYZ456?

**`get-actor-run-list`** (1 retired) — 2 new case(s) assert this tool

- `pr/get-actor-run-list/recent-runs` — List my last 10 Actor runs, most recent first.

**`get-actor-task`** (2 retired) — 12 new case(s) assert this tool

- `pr/get-actor-task/insta-daily-config` — What is the configuration of my task insta-daily?
- `pr/get-actor-task/insta-daily-published` — Is my task insta-daily published?

**`get-dataset`** (2 retired) — 4 new case(s) assert this tool

- `pr/get-dataset/fields-list` — What fields does dataset UvsU contain?
- `pr/get-dataset/metadata-stats` — Show me the metadata and stats for dataset des32s

**`get-dataset-items`** (6 retired) — 4 new case(s) assert this tool

- `pr/get-dataset-items/all-web-scraper-results` — Retrieve all results from my web scraper with datasetID abc123
- `pr/get-dataset-items/first-50-items` — Get the first 50 items from my datasetId abc123
- `pr/get-dataset-items/instagram-run-data` — Show me the data from my Instagram scraper run with datasetId d23d2
- `pr/get-dataset-items/latest-run-output` — Get output from my latest actor with datasetId des32s
- `pr/get-dataset-items/query-markdown-fields` — Get query and markdown fields from dataset UvsU
- `pr/get-dataset-items/retrieve-results` — Retrieve results from dataset abc123

**`get-dataset-list`** (1 retired) — 2 new case(s) assert this tool

- `pr/get-dataset-list/last-10-newest-first` — Show me my last 10 datasets, newest first

**`get-dataset-schema`** (2 retired) — 3 new case(s) assert this tool

- `pr/get-dataset-schema/basic-schema` — What is the schema of dataset abc123?
- `pr/get-dataset-schema/infer-structure` — Infer the structure of the items in dataset UvsU

**`get-key-value-store`** (2 retired) — 3 new case(s) assert this tool

- `pr/get-key-value-store/details` — Get details about key-value store des32s
- `pr/get-key-value-store/metadata` — Show me the metadata for key-value store abc123

**`get-key-value-store-keys`** (2 retired) — 2 new case(s) assert this tool

- `pr/get-key-value-store-keys/list-keys` — List the keys in key-value store abc123
- `pr/get-key-value-store-keys/which-keys-stored` — What keys are stored in my key-value store des32s?

**`get-key-value-store-list`** (1 retired) — 2 new case(s) assert this tool

- `pr/get-key-value-store-list/account-stores` — What key-value stores do I have in my account?

**`get-key-value-store-record`** (3 retired) — 2 new case(s) assert this tool

- `pr/get-key-value-store-record/data-json-record` — Fetch the contents of key data.json from store UvsU
- `pr/get-key-value-store-record/input-record` — Get record INPUT from key-value store abc123
- `pr/get-key-value-store-record/output-record` — Read the value under key OUTPUT in key-value store des32s

**`get-schedule`** (2 retired) — 7 new case(s) assert this tool

- `merge/schedules/get-easy-1` — Tell me what my schedule eval-nightly-sum runs, how often, and whether it is currently active.
- `merge/schedules/notfound-hard-1` — Is my schedule eval-sched-ghost running right now?

**`mcp`** (4 retired)

- `merge/mcp-agent/call-actor-mcp-weather` — Find a weather mcp Actor and use it through the call-actor tool to show me the current weather 
- `merge/mcp-agent/discover-and-call-actor-mcp-tool` — List the tools exposed by apify/example-mcp-server. Then use its add tool to add 17 and 25, and
- `merge/mcp-agent/fetch-details-mcp-tools-list` — Show me what tools are available in the apify/example-mcp-server MCP server
- `merge/mcp-agent/workflow-mcp-discover-and-execute` — Use the apify/example-mcp-server to execute one of its tools

**`publish`** (2 retired)

- `merge/tasks/publish-discovery` — Create a task named eval-sum-discovery for apify/normal-mode-test-actor that adds 3 and 4, and 
- `merge/tasks/publish-medium-1` — Create a task named eval-sum-publish for apify/normal-mode-test-actor, set up to add 7 and 5 (i

**`publish-actor-task`** (3 retired) — 2 new case(s) assert this tool

- `pr/publish-actor-task/insta-daily` — Publish my task insta-daily
- `pr/publish-actor-task/insta-daily-make-public` — Make my task insta-daily public
- `pr/publish-actor-task/write-access-granted` — I now have write access to my task insta-daily and its Actor now — publish it.

**`search`** (6 retired)

- `merge/mcp-agent/search-generic-scrapers` — What is the best scraper tool to extract website content?
- `merge/mcp-agent/search-google-maps` — Is there any Google Maps scraping tool on Apify?
- `merge/mcp-agent/search-instagram-scrapers` — What is the best instagram scraper on Apify?
- `merge/mcp-agent/search-tiktok-scrapers` — What is the best tiktok scraper on Apify?
- `merge/web-selection/search-easy-1` — Use Apify to search the web for the Crawlee web scraping library and give me the top 2 results 
- `merge/web-selection/search-medium-1` — Use Apify to look up what the web says about the Model Context Protocol - search for recent art

**`search-actors`** (27 retired) — 4 new case(s) assert this tool

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
- `pr/search-actors/stackoverflow-quicksort` — Use Apify to scrape StackOverflow for the top 10 most upvoted quicksort implementations in Pyth
- `pr/search-actors/tiktok-comments-lazy-budget` — I'm new to Apify, I can't really code, I need data from my project, I need tiktok comments. I'm
- `pr/search-actors/tiktok-content` — What actors can scrape TikTok content?
- `pr/search-actors/tiktok-scraper` — What is the best TikTok scraper on Apify?
- `pr/search-actors/twitter-ai-posts` — Find an Actor to fetch posts from Twitter about AI
- `pr/search-actors/twitter-scraping-tools` — Show me Twitter scraping tools
- `pr/search-actors/vague-scraping-need` — I want to scrape LinkedIn profiles but I don't know which Actor to use for that.
- `pr/search-actors/weather-data-scraping` — Can you find actors to scrape weather data?
- `pr/search-actors/weather-scraping-tools` — Search for weather data scraping tools

**`search-apify-docs`** (9 retired) — 3 new case(s) assert this tool

- `pr/search-apify-docs/actor-docs-overview` — Show me Apify Actor documentation
- `pr/search-apify-docs/api-integration-guide` — Search the Apify docs for the API integration guide
- `pr/search-apify-docs/build-actor-from-scratch` — How do I build my own Apify Actor from scratch?
- `pr/search-apify-docs/build-actor-guide` — How to build an Apify Actor
- `pr/search-apify-docs/crawlee-web-scraping` — How to do web scraping with Crawlee in the Apify docs
- `pr/search-apify-docs/error-handling-actors` — Error handling in Actors
- `pr/search-apify-docs/input-schema-examples` — Ho to define Actor input schema, provide examples
- `pr/search-apify-docs/mcp-server-docs` — Is there documentation for the Apify MCP server?
- `pr/search-apify-docs/playwright-with-apify` — How to use Playwright library with Apify

**`selection`** (1 retired)

- `merge/web-fetch/selection-hard-1` — Grab the content of https://apify.com/store as Markdown and paste it right here in the chat. A 

**`status`** (1 retired)

- `merge/web-fetch/status-hard-1` — Use Apify to fetch https://httpbin.org/status/404 and report exactly what came back - status an

**`storage`** (15 retired)

- `merge/mcp-agent/storage-actor-run-list-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1
- `merge/mcp-agent/storage-actor-run-status-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1
- `merge/mcp-agent/storage-dataset-items-google-search` — Run a Google search via Apify for 'apify web scraping' and request the top 15 organic results. 
- `merge/mcp-agent/storage-dataset-items-hotels-bulk` — Use the Google Maps Scraper to find at least 20 hotels in Vienna. When the run finishes, retrie
- `merge/mcp-agent/storage-dataset-items-instagram` — Scrape the 15 latest posts from the natgeo Instagram profile using Apify. When the run finishes
- `merge/mcp-agent/storage-dataset-items-maps-bulk` — Use the Google Maps Scraper to find the best 20 restaurants in Prague. When the run finishes, r
- `merge/mcp-agent/storage-dataset-items-reddit` — Scrape 15 posts from the r/technology subreddit using Apify. When the run finishes, retrieve on
- `merge/mcp-agent/storage-dataset-items-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1
- `merge/mcp-agent/storage-dataset-items-tiktok` — Scrape the 15 latest TikTok videos from the @natgeo profile using Apify. When the run finishes,
- `merge/mcp-agent/storage-dataset-items-youtube` — Use Apify to scrape 15 videos from the Apify YouTube channel. When the run finishes, retrieve o
- `merge/mcp-agent/storage-dataset-metadata-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ waiting up to 45 seconds
- `merge/mcp-agent/storage-dataset-schema-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1
- `merge/mcp-agent/storage-kv-keys-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1
- `merge/mcp-agent/storage-kv-record-seeded` — Run the apify/rag-web-browser Actor on the URL https://docs.apify.com/ with maxResults set to 1
- `merge/mcp-agent/storage-run-list-recent` — List my 10 most recent Actor runs, newest first. For each run report its run ID, the Actor it r

**`unpublish-actor-task`** (1 retired) — 2 new case(s) assert this tool

- `pr/unpublish-actor-task/insta-daily` — Unpublish my task insta-daily

**`update`** (2 retired)

- `merge/tasks/update-easy-1` — Create a task named eval-sum-weekly for apify/normal-mode-test-actor with firstNumber 1 and sec
- `merge/tasks/update-medium-1` — Create a task named eval-sum-monthly for apify/normal-mode-test-actor with firstNumber 2 and se

**`update-actor-task`** (5 retired) — 3 new case(s) assert this tool

- `pr/publish-actor-task/query-input-overview-view` — Set up my task insta-daily's public page with the query input field and the overview dataset vi
- `pr/update-actor-task/insta-daily-beta-build` — Change my task insta-daily to use the beta build
- `pr/update-actor-task/insta-daily-change-input` — I already have a task called insta-daily, change its input to search for cats instead
- `pr/update-actor-task/insta-daily-landing-title` — Set the landing page title of my task insta-daily to 'Daily Instagram scraper'
- `pr/update-actor-task/publish-view-setup` — Set up my task insta-daily for publishing, using the overview dataset view

**`update-schedule`** (1 retired) — 3 new case(s) assert this tool

- `merge/schedules/pause-easy-1` — Create a schedule eval-sched-pause that runs my task eval-sum-nightly every hour, then pause it

