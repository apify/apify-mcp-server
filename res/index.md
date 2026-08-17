# Resources Directory Index

Ad-hoc technical references about the repository: architecture analyses, design decisions,
protocol notes. **Code is the source of truth** — these docs may drift; verify against the
current source before trusting line numbers or symbol names.

## Files

### [call_actor_redesign_v4.md](./call_actor_redesign_v4.md)
The shipped `call-actor` / `get-actor-run` V4 response contract (PRs #823/#825): canonical
storage shape, `summary`/`nextStep`, locked decisions table. Implementation in
`src/tools/actors/actor_run_response.ts`.

### [pricing_output_contract.md](./pricing_output_contract.md)
Pricing output of `fetch-actor-details` (complete) vs `search-actors` (simplified). Worked
examples E1–E8 as a test oracle, used by `tests/unit/utils.pricing_info.test.ts`. Rules live in
`src/utils/pricing_info.ts`.

### [tasks_cancel_abort_flow.md](./tasks_cancel_abort_flow.md)
How `tasks/cancel` propagates to `apifyClient.run(runId).abort()` (PR #812 / issue #763).
Sequence diagrams, the polling-watcher rationale, multi-node reasoning, hardening notes.
Touch when changing `createTaskCancellationWatcher` or the abort path in
`src/tools/actors/actor_run_response.ts`.

### [chatgpt-app-submission.md](./chatgpt-app-submission.md)
Checklist and notes for ChatGPT MCP Apps store submission. In progress — screenshots, test
prompts and localization are still open.

### [refactoring-sweep-2026-07.md](./refactoring-sweep-2026-07.md)
What's left of the 2026-07-08 codebase sweep: the M/L backlog nobody filed (`types.ts` split,
payment seam, `internals.js` narrowing, test import time). Pull from it instead of re-sweeping.

### [code_runtime_eval.md](./code_runtime_eval.md)
Blind A/B runbook for `apify/code-runtime` (Code Mode) vs normal Actor tool use: 7 tests, the
single mode-line variable, how to measure tokens and Apify spend, per-test grading checks.

### [code_runtime_eval_results.md](./code_runtime_eval_results.md)
Results of that runbook, 2026-08-08 on Sonnet 5: per-run cost/wall/pass table, mode-held audit,
retry counts, and the confounds to fix before re-running.

---

## Guidelines

- Keep documents **short and technical** — don't duplicate code logic.
- Focus on **insights, decisions, and "why"** rather than reproducing implementation details.
- Prefer **symbol names** over brittle line numbers when pointing at code.
- When a documented feature ships, trim the doc to a gist that points at the code; delete it
  when the code fully supersedes it. Delete abandoned design proposals rather than letting
  them rot.
- A doc that schedules its own deletion ("delete when #N closes") gets deleted when that
  happens — don't leave it for the next sweep.
