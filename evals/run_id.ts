/**
 * Name grammar for a run's eval resources: `<static>-<runId>-n<runId length>-t<trial>r<attempt>`.
 * The runner builds the suffix and the fixtures script matches it, so the two cannot drift.
 */

const RUN_ID_PATTERN = /^[a-z0-9-]+$/;

/** A CI id is 13 characters; longer ids push resolved names past the platform's 63. */
export const RUN_ID_MAX_LENGTH = 18;

const RUN_ID_FLAG = '--run-id';

/** Id for one local run; the random tail separates two runs started in the same second. */
export function createRunId(): string {
    const seconds = Math.floor(Date.now() / 1000).toString(36);
    const random = Math.random().toString(36).slice(2, 6);
    return `${seconds}${random}`;
}

/** Suffix for one agent run: `trial` is the `--iterations` index, `attempt` is 1 or 2 on the retry. Both count from 1. */
export function buildRunSuffix(runId: string, trial: number, attempt: number): string {
    return `${runId}-n${runId.length}-t${trial}r${attempt}`;
}

/** The length after the id distinguishes `a-1` from `1` as well as CI run attempt 12 from 1. */
export function isNameFromRun(name: string, runId: string): boolean {
    return name.includes(`-${runId}-n${runId.length}-t`);
}

/** Throws when a `--run-id` would build a name the platform rejects. */
export function validateRunId(value: string): void {
    if (!RUN_ID_PATTERN.test(value)) {
        throw new Error(`--run-id must be lowercase letters, digits and dashes, got "${value}"`);
    }
    if (value.length > RUN_ID_MAX_LENGTH) {
        throw new Error(`--run-id must be at most ${RUN_ID_MAX_LENGTH} characters, got ${value.length}`);
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
