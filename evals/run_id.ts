/**
 * Name grammar for a run's eval resources: `<static>-<runId>-t<trial>`.
 * The runner builds the suffix and the fixtures scripts match it, so the two cannot drift.
 */

const RUN_ID_PATTERN = /^[a-z0-9-]+$/;

const RUN_ID_FLAG = '--run-id';

/** Id for one local run; the random tail separates two runs started in the same second. */
export function createRunId(): string {
    const seconds = Math.floor(Date.now() / 1000).toString(36);
    const random = Math.random().toString(36).slice(2, 6);
    return `${seconds}${random}`;
}

/** Name suffix for one trial of one item; `trial` is 1-based. */
export function buildRunSuffix(runId: string, trial: number): string {
    return `${runId}-t${trial}`;
}

/**
 * Matched as a delimited token, because a bare `includes('35014680476-1')` also matches attempt
 * 12's `…-35014680476-12-t1`.
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
 * A value starting with `--` is an error, not an id: `--run-id --dry-run` would otherwise swallow
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
