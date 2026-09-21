import { describe, expect, it } from 'vitest';

import { buildRunSuffix, createRunId, isNameFromRun, parseRunIdArg, validateRunId } from '../../evals/run_id.js';

/** The longest run id CI produces: `<github.run_id>-<github.run_attempt>`. */
const CI_RUN_ID = '35014680476-1';
/** The platform's cap on a schedule or task name. */
const MAX_RESOURCE_NAME_LENGTH = 63;

describe('createRunId()', () => {
    it('builds an id of lowercase letters and digits only', () => {
        expect(createRunId()).toMatch(/^[a-z0-9]+$/);
    });

    it('builds a different id on each call', () => {
        expect(createRunId()).not.toBe(createRunId());
    });
});

describe('buildRunSuffix()', () => {
    it('joins the run id and the trial into a dash-and-alphanumeric token', () => {
        expect(buildRunSuffix('r3k9f2qa7c', 2)).toBe('r3k9f2qa7c-t2');
        expect(buildRunSuffix(CI_RUN_ID, 1)).toMatch(/^[a-z0-9-]+$/);
    });

    it('leaves room for the static part of a name under the platform limit', () => {
        const suffix = buildRunSuffix(CI_RUN_ID, 3);
        expect(`eval-sched-add-${suffix}`.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME_LENGTH);
    });

    it('builds a different suffix per trial and per run', () => {
        expect(buildRunSuffix(CI_RUN_ID, 1)).not.toBe(buildRunSuffix(CI_RUN_ID, 2));
        expect(buildRunSuffix('35014680476-2', 1)).not.toBe(buildRunSuffix(CI_RUN_ID, 1));
    });
});

describe('isNameFromRun()', () => {
    it('matches a name this run created', () => {
        expect(isNameFromRun(`eval-sched-add-${buildRunSuffix(CI_RUN_ID, 1)}`, CI_RUN_ID)).toBe(true);
        expect(isNameFromRun(`eval-sched-add-${buildRunSuffix(CI_RUN_ID, 12)}`, CI_RUN_ID)).toBe(true);
    });

    it('does not match a longer run id that starts with this one', () => {
        expect(isNameFromRun('eval-sched-add-35014680476-12-t1', CI_RUN_ID)).toBe(false);
    });

    it('does not match another run or an unrelated name', () => {
        expect(isNameFromRun('eval-sched-add-r8m1p4bz2q-t1', CI_RUN_ID)).toBe(false);
        expect(isNameFromRun('eval-nightly-sum', CI_RUN_ID)).toBe(false);
    });

    it('does not match the run id without the trial delimiter', () => {
        expect(isNameFromRun(`eval-sched-add-${CI_RUN_ID}`, CI_RUN_ID)).toBe(false);
    });
});

describe('validateRunId()', () => {
    it('accepts lowercase letters, digits and dashes', () => {
        expect(() => validateRunId(CI_RUN_ID)).not.toThrow();
        expect(() => validateRunId('r3k9f2qa7c')).not.toThrow();
    });

    it('rejects characters outside [a-z0-9-] and an empty value', () => {
        expect(() => validateRunId('Run_1')).toThrow(/--run-id must be lowercase letters, digits and dashes/);
        expect(() => validateRunId('run 1')).toThrow(/--run-id/);
        expect(() => validateRunId('')).toThrow(/--run-id/);
    });
});

describe('parseRunIdArg()', () => {
    it('reads the value that follows the flag', () => {
        expect(parseRunIdArg(['node', 'script.js', '--run-id', CI_RUN_ID, '--dry-run'])).toBe(CI_RUN_ID);
    });

    it('reads the value from the equals form', () => {
        expect(parseRunIdArg(['node', 'script.js', `--run-id=${CI_RUN_ID}`, '--dry-run'])).toBe(CI_RUN_ID);
    });

    it('returns undefined when the flag is absent', () => {
        expect(parseRunIdArg(['node', 'script.js', '--dry-run'])).toBeUndefined();
    });

    it('rejects a flag with no value', () => {
        expect(() => parseRunIdArg(['node', 'script.js', '--run-id'])).toThrow(/--run-id needs a value/);
        expect(() => parseRunIdArg(['node', 'script.js', '--run-id='])).toThrow(/--run-id needs a value/);
    });

    it('rejects the next flag as a value', () => {
        expect(() => parseRunIdArg(['node', 'script.js', '--run-id', '--dry-run'])).toThrow(/--run-id needs a value/);
        expect(() => parseRunIdArg(['node', 'script.js', '--run-id=--dry-run'])).toThrow(/--run-id needs a value/);
    });

    it('rejects a value outside [a-z0-9-]', () => {
        expect(() => parseRunIdArg(['node', 'script.js', '--run-id', 'Run_1'])).toThrow(
            /--run-id must be lowercase letters, digits and dashes/,
        );
        expect(() => parseRunIdArg(['node', 'script.js', '--run-id=Run_1'])).toThrow(
            /--run-id must be lowercase letters, digits and dashes/,
        );
    });
});
