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

### [2026-09-04-selection-mode-spike.md](./2026-09-04-selection-mode-spike.md)
Executed spike for selection mode (apify/ai-team#260): deny-all PreToolUse capture, the
clean-stop denial wording, the `ToolSearch` false-first-call caveat, `--iterations` via
repeated items in one `experiment.run()`, Langfuse v4 endpoint map. Throwaway scripts under
`evals/mcp_agent/spike/`. A dated record — do not edit; delete both once #260 ships.

## Rules

- A note gets a **deletion trigger** when it is written ("delete when X ships / closes / is
  decided"). Honour it — don't leave it for the next sweep.
- No architecture analyses, no protocol references, no refactor backlogs. Those go to
  `AGENTS.md`, a docstring, or a GitHub issue.
