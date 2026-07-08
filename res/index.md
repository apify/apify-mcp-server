# Resources Directory Index

Ad-hoc technical references about the repository: architecture analyses, design decisions,
protocol notes. **Code is the source of truth** — these docs may drift; verify against the
current source before trusting line numbers or symbol names.

## Files

### [call_actor_redesign_v4.md](./call_actor_redesign_v4.md)
The shipped `call-actor` / `get-actor-run` V4 response contract (PRs #823/#825): canonical
storage shape, `summary`/`nextStep`, locked decisions table. Implementation in
`src/tools/core/actor_run_response.ts`.

### [pricing_output_contract.md](./pricing_output_contract.md)
Pricing output of `fetch-actor-details` (complete) vs `search-actors` (simplified). Worked
examples E1–E8 as a test oracle. Rules live in `src/utils/pricing_info.ts`.

### [actor_input_schema_required_fields.md](./actor_input_schema_required_fields.md)
Apify input-schema semantics (required vs default vs prefill) behind `fixZodSchemaRequired`.
#637 fix is in `src/utils/ajv.ts`; keeps the still-open #675 follow-up.

### [tasks_cancel_abort_flow.md](./tasks_cancel_abort_flow.md)
How `tasks/cancel` propagates to `apifyClient.run(runId).abort()` (PR #812 / issue #763).
Sequence diagrams, the polling-watcher rationale, multi-node reasoning, hardening notes.
Touch when changing `createTaskCancellationWatcher` or the abort path in
`src/tools/core/actor_run_response.ts`.

### [mcp_task_reference.md](./mcp_task_reference.md)
MCP task lifecycle, SDK types, and capabilities declaration. `executeToolAndUpdateTask` with
the `mcpTaskExecution` flag. Lists available-but-unused SDK features (resource links, dynamic
resources, elicitation, completion).

### [mcp_resources_analysis.md](./mcp_resources_analysis.md)
MCP resources behavior: low-level `Server` API, Skyfire readme + UI widgets, handlers
delegating to `src/resources/resource_service.ts`. Templates/subscriptions not implemented.

### [integration_test_coverage_audit.md](./integration_test_coverage_audit.md)
Point-in-time audit of protocol gaps in `tests/integration/suite.ts` (resources, logging,
progress, ping, initialize, HTTP-level, session isolation, `_meta.apifyToken`). Live plan —
tracked by umbrella issue #777.

### [integration_test_coverage_plan.md](./integration_test_coverage_plan.md)
PR-by-PR breakdown of the audit above. Live plan (#777); sub-issues #750–#754, #766.

### [chatgpt-app-submission.md](./chatgpt-app-submission.md)
Checklist and notes for ChatGPT MCP Apps store submission. In progress — verify line
references against current source before relying on them.

### [refactoring-sweep-2026-07.md](./refactoring-sweep-2026-07.md)
Full-codebase sweep results: defects and refactorings filed as #1064/#1065/#1066, plus the
unfiled M/L backlog (types.ts split, payment seam, `internals.js` narrowing, test import
time). Pull from the backlog instead of re-sweeping.

### [web-widget-bundle-size.md](./web-widget-bundle-size.md)
Keeping widget bundles small (narrow `@apify/ui-library/dist/src/...` imports, markdown stack
cost). Re-measure when changing widget dependencies or markdown rendering.

---

## Guidelines

- Keep documents **short and technical** — don't duplicate code logic.
- Focus on **insights, decisions, and "why"** rather than reproducing implementation details.
- Prefer **symbol names** over brittle line numbers when pointing at code.
- When a documented feature ships, trim the doc to a gist that points at the code; delete it
  when the code fully supersedes it. Delete abandoned design proposals rather than letting
  them rot.
