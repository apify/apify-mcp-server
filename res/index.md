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

### [skills_evals_dataset.md](./skills_evals_dataset.md)
How to create the `skills-evals` Langfuse dataset and its first case. The harness support for
Apify agent skills is in; the dataset is not. Delete once the dataset exists and its first wave
of cases is calibrated.

### [code_runtime_eval.md](./code_runtime_eval.md)
Blind A/B runbook for `apify/code-runtime` (Code Mode) vs normal Actor tool use: 7 tests, the
single mode-line variable, how to measure tokens and Apify spend, per-test grading checks.

### [code_runtime_eval_results.md](./code_runtime_eval_results.md)
Results of that runbook, 2026-08-08 on Sonnet 5: per-run cost/wall/pass table, mode-held audit,
retry counts, and the confounds to fix before re-running. A dated record — do not edit it after
the fact; a re-run gets its own file.

## Rules

- A note gets a **deletion trigger** when it is written ("delete when X ships / closes / is
  decided"). Honour it — don't leave it for the next sweep.
- No architecture analyses, no protocol references, no refactor backlogs. Those go to
  `AGENTS.md`, a docstring, or a GitHub issue.
