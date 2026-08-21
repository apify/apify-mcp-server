---
name: creating-workflow-evals
description: Use when adding Langfuse workflow evals for a tool family of the Apify MCP server ("create evals for the storage tools"), when eval cases fail and you must decide whether the case, the tool, or its description is at fault, or when eval runs show tool errors in Langfuse traces.
---

# Creating workflow evals for an MCP tool family

## Overview

Build a small, calibrated Langfuse eval suite for one tool family (tasks, storage, runs, …), then use its failures to fix the tools. Core principle: **evals are designed from user intent, never from tool descriptions** — the eval defines what should work; descriptions get fixed afterward to make naive agents pass it.

Commands, item shapes, probe patterns, and sweep queries: [reference.md](reference.md).

## The flow

1. **Inventory the tools** — every tool and every argument group needs at least one case (the coverage matrix at the end proves it).
2. **Probe the platform first.** Before writing any case that depends on API behavior (required fields, uniqueness rules, limits, error messages), verify it with a throwaway `tsx` script against the real API. Never write a case on an assumed contract — that's how you get input values the schema rejects.
3. **Two datasets, never one**: `<family>-evals` (proper suite, zero tool errors tolerated) and `<family>-evals-errors` (cases that provoke errors on purpose: collisions, not-found, requirement discovery). Mixing them masks real failures.
4. **Write cases in waves**: 2–3 easy (single tool, explicit input) → 1–2 medium (cross-tool chains, run options) → 2–3 hard (vague user language, error recovery, collisions). Run and review each wave before writing the next.
5. **Calibrate on the strongest model first** (Opus). A failure there is a case defect or a product gap — never a description problem. Only a calibrated suite (strong model 100%) can attribute weaker-model failures to descriptions.
6. **Ladder down** (Sonnet → Haiku). Passes-on-Opus-fails-on-Haiku = the tool description or output doesn't carry a naive agent. That's the signal you built the suite for.
7. **Fix tools via outputs before descriptions.** A steering sentence in the tool's response summary/nextStep reaches every agent on every call; description text gets skimmed. Both output nudges that fixed Haiku failures in the original build were response-text changes.

## Diagnosing a failed case — in this order

| Suspect | Symptoms | Fix |
|---|---|---|
| **The case** | Query references context the agent can't obtain ("my usual setup"); input violates the actor's schema; the smart model's "wrong" behavior is actually defensible | Rewrite query self-contained; give round trips a purpose ("confirm it's live, then take it down") |
| **The judge/reference** | Agent did the right thing, reference demands the impossible (e.g. echo values the tool never returns) | Reword `expectedOutput`; it must only require what's observable (judge sees tool calls + args + final text, never tool results) |
| **The product** | The tool cannot satisfy a natural user request by design | Surface as a decision, don't silently adjust the case or the tool |
| **The description/output** | Naive model stalls to ask, guesses instead of using a discovery tool, hallucinates from an ambiguously named field | Output nudge first, description second; rename fields whose names invite misreading |
| **The world** | The live target page is down, changed, or empty (a 503 outage, a profile with zero posts) — the agent behaved correctly | Move content-bearing cases to stable hosts; where HTTP behavior IS the axis, make the reference outage-tolerant (a truthfully reported upstream error is a PASS path) |
| **The model** | Correct tool choice but a policy-shaped refusal (long verbatim reproduction, "placeholder domain"), or a bad habit that survives nudges at every layer you own | Refusal → scope the deliverable below the threshold (one section, public-domain text); reproducible habit after description + parameter fixes → keep the case, document the residual, stop tuning |

Always read the transcript before assigning blame. The judge's one-liner is a hint, not a diagnosis.

## Rules that prevent rework

- **References are judge-checkable contracts**: "PASS only if `<tool>` was called with `<arg>` and the final answer states `<fact>`. FAIL if …". Never "the agent should handle it well".
- **Queries in user language.** A query that names tools tests parroting, not descriptions. Hard cases must never name a tool.
- **Truth in telemetry.** Never downgrade span levels to hide expected errors — that masks real ones. Expected errors live in the error suite; the proper suite's gate is `tool_errors == 0` over **server (MCP) tool calls** (failed read-only probes count: guessing a slug instead of searching is a failure; the agent's built-in tools are exempt — their stumbles are client noise, not ours).
- **Write judge-blindness clauses.** The judge never sees tool results, so references must pre-empt misreadings: an agent narrating a quirk ("the count read 0 but the items were there") is not admitting failure; content delivered via a clearly-attributed fallback is retrieved, not fabricated; and never require narrating an event (a block, an error) that a legitimate alternative path skips entirely.
- **Fail false claims, not silent success.** Outcome and honesty are the axes; etiquette (announcing a tool switch, apologizing for a detour) is a bonus, never a PASS condition.
- **Selection cases need exactly one right answer.** A target a second legitimate tool also serves (an Apify docs URL when `fetch-apify-docs` is loaded) makes defensible behavior fail; pick targets where only the tool under test fits.
- **Probe the target, not just the mechanism.** For live-web cases, fetch the exact URL at authoring time and check the *content* supports the premise (a probed-working scraper still returned nothing for a profile that turned out to have zero posts).
- **State is account-global.** Fixed `eval-` prefixed resource names + a fixtures seed/cleanup script; each conversation self-contained (create → act → clean up); one permanent read-only fixture for pure "get" cases.
- **Dataset item ids are project-unique forever** — they cannot move between datasets or be reused after archiving. Choose ids you can live with; "moving" a case = new id + archive old.
- **Snapshot after every dataset edit** (`evals:workflow:export-dataset --dataset X`) so git reviews the cases.

## Red flags — stop and rethink

- Writing a case while looking at the tool's description → you're testing parroting. Close the file.
- Adding an expected-error match/filter to the proper suite → move the case to the error suite instead.
- A rerun "fixed" a failure you didn't diagnose → known harness flake ("task threw, never completed") is retry-once; a judged FAIL is never a flake, read the transcript.
- Editing the tool because one model failed once → reproduce or diagnose first; single runs are stochastic.
- An obviously fake URL in a query (`ftp.example.com`, `this-is-a-test.com`) → models defensibly refuse "placeholder" targets; use a real host, and a nonexistent path on it when the fetch must fail.
- A deliverable demanding word-for-word reproduction of more than a few hundred words → some models refuse on reproduction grounds with zero tool calls, regardless of licensing; the case then measures refusal thresholds, not tool selection.
- A case whose side quests aren't the tested axis (huge payloads inviting file delivery or byte-exact verification) → have the user ask for in-chat delivery and pre-authorize truncation, and budget `maxTurns` for the recovery path, not the happy path.

## Common mistakes

| Mistake | Consequence |
|---|---|
| One dataset for everything | Error-provoking cases force error tolerance onto clean cases; red spans everywhere mean nothing |
| Calibrating on the cheap model | Can't tell case bugs from description bugs; you'll "fix" descriptions against broken cases |
| `maxTurns` too low on chain cases | Agent runs out of turns mid-flow and the judge sees an unfinished transcript |
| Fixed names without cleanup | Second run collides with the first run's leftovers; nondeterministic failures |
| Skipping the wave review | A systematic case-authoring flaw (e.g. unknowable context) replicates into every hard case |
