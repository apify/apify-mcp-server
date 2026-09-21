# res/ — working notes

Ephemeral working documents: in-flight checklists and dated experiment records. Nothing here
is a reference for how the code works.

**Durable facts belong in `AGENTS.md`; the "why" behind a decision belongs in the docstring of
the code that owns it.** If a note here starts explaining the codebase, it is in the wrong
place — move it and delete the note.

## Files

### [chatgpt-app-submission.md](./chatgpt-app-submission.md)
Checklist for the ChatGPT MCP Apps store submission. In progress — screenshots, test prompts
and localization are still open. Delete once the submission is decided either way.

### [code_runtime_eval.md](./code_runtime_eval.md)
Blind A/B runbook for `apify/code-runtime` (Code Mode) vs normal Actor tool use: 7 tests, the
single mode-line variable, how to measure tokens and Apify spend, per-test grading checks.

### [code_runtime_eval_results.md](./code_runtime_eval_results.md)
Results of that runbook, 2026-08-08 on Sonnet 5: per-run cost/wall/pass table, mode-held audit,
retry counts, and the confounds to fix before re-running. A dated record — do not edit it after
the fact; a re-run gets its own file.

### [mcp_tool_coverage_evals.md](./mcp_tool_coverage_evals.md)
The two rebuilt Langfuse eval datasets (`mcp-server-evals-pr-v2`, `mcp-server-evals-merge-v2`):
why they load every tool at once, what they cover, the findings that came out of building them,
and the environment traps that corrupt a calibration run. Delete once they replace the live
datasets in `_evaluations.yaml`.

### [mcp_eval_cases_review.md](./mcp_eval_cases_review.md)
Every new eval case in full — query, asserted tools, arguments, judge reference — plus every v1
wording retired, grouped by tool. Generated, not hand-edited; regenerate rather than patch. For
reviewing the case content before the migration in #1411. Delete once that lands.

### [eval_cases_review/](./eval_cases_review/)
The new eval cases as editable JSON, the v1 cases they retire, each case's current pass/fail per
model, and `CHANGES.md` comparing them per tool. For reviewing and correcting cases by hand before
the migration in #1411: edit the JSON, and it upserts straight back into the staging datasets by
`id`. Delete once the cases are migrated.

## Rules

- A note gets a **deletion trigger** when it is written ("delete when X ships / closes / is
  decided"). Honour it — don't leave it for the next sweep.
- No architecture analyses, no protocol references, no refactor backlogs. Those go to
  `AGENTS.md`, a docstring, or a GitHub issue.
