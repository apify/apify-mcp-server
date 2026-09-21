/**
 * The per-run name grammar for eval resources: `<static>-<runId>-t<trial>`.
 *
 * Both sides live here — the runner builds the suffix it substitutes into an item's `{{uniq}}`
 * marker, the fixtures scripts match it when they tear a run down — so the two cannot drift.
 * Names stay within `[a-z0-9-]`, which the platform's schedule and task name rules accept.
 */

const RUN_ID_PATTERN = /^[a-z0-9-]+$/;

/** The CLI flag that carries a run id, in both its `--run-id <value>` and `--run-id=<value>` forms. */
const RUN_ID_FLAG = '--run-id';

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

/**
 * The run id an argv carries, or undefined when the flag is absent. Pure: the caller decides what a
 * throw means (the fixtures scripts print it and exit).
 *
 * A value that starts with `--` is an error, not an id: `--run-id --dry-run` would otherwise swallow
 * the next flag, and `--dry-run` matches the id pattern.
 */
export function parseRunIdArg(argv: string[]): string | undefined {
    const index = argv.findIndex((arg) => arg === RUN_ID_FLAG || arg.startsWith(`${RUN_ID_FLAG}=`));
    if (index === -1) return undefined;
    const arg = argv[index];
    const value = arg === RUN_ID_FLAG ? argv[index + 1] : arg.slice(`${RUN_ID_FLAG}=`.length);
    if (!value || value.startsWith('--')) throw new Error(`${RUN_ID_FLAG} needs a value`);
    validateRunId(value);
    return value;
}
