/**
 * The per-run name grammar for eval resources: `<static>-<runId>-t<trial>`.
 *
 * Both sides live here — the runner builds the suffix it substitutes into an item's `{{uniq}}`
 * marker, the fixtures scripts match it when they tear a run down — so the two cannot drift.
 * Names stay within `[a-z0-9-]`, which the platform's schedule and task name rules accept.
 */

const RUN_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Identifier for one local run. Base36 seconds keeps it short; the random tail separates two runs
 * started in the same second. CI passes `<github.run_id>-<github.run_attempt>` instead.
 */
export function createRunId(): string {
    const seconds = Math.floor(Date.now() / 1000).toString(36);
    const random = Math.random().toString(36).slice(2, 6);
    return `${seconds}${random}`;
}

/** Name suffix for one trial of one item; `trial` is the 1-based iteration. */
export function buildRunSuffix(runId: string, trial: number): string {
    return `${runId}-t${trial}`;
}

/**
 * Whether a resource name was created by this run. Matched as a delimited token (`-<runId>-t`),
 * never as a bare substring: `includes('35014680476-1')` also matches attempt 12's
 * `…-35014680476-12-t1`, so a teardown would delete what a sibling run is still asserting on.
 */
export function isNameFromRun(name: string, runId: string): boolean {
    return name.includes(`-${runId}-t`);
}

/** Throws when a `--run-id` would build a name the platform rejects. */
export function validateRunId(value: string): void {
    if (!RUN_ID_PATTERN.test(value)) {
        throw new Error(`--run-id must be lowercase letters, digits and dashes, got "${value}"`);
    }
}
