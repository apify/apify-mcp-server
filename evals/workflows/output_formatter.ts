/**
 * End-of-run console summary for the workflow-eval orchestrator.
 *
 * Harbor executes the trials and Opik stores the traces; this only renders a table of each
 * executed trial's verdict (derived from the verifier reward) plus its judge reason, and the
 * pass/fail totals the orchestrator uses for its exit code.
 */

/** Outcome of one executed Harbor trial, built from its result.json + verifier stdout. */
export type TrialOutcome = {
    /** Test case id (task name without the org prefix). */
    id: string;
    category?: string;
    /** Verifier reward: 1 = PASS, 0 = FAIL, null = no reward recorded (verifier crashed). */
    reward: number | null;
    /** Judge reason (from verifier stdout) or an error explanation. */
    reason: string;
};

/** A trial passed only when it recorded a reward of exactly 1. */
export function isPass(outcome: TrialOutcome): boolean {
    return outcome.reward === 1;
}

/** Pass/fail/error totals for the run. */
export function summarize(outcomes: TrialOutcome[]): {
    total: number;
    passed: number;
    failed: number;
    errored: number;
} {
    const total = outcomes.length;
    const passed = outcomes.filter(isPass).length;
    const errored = outcomes.filter((outcome) => outcome.reward === null).length;
    return { total, passed, failed: total - passed - errored, errored };
}

/** Render the results table plus a summary block. `skipped` lists cases the harness could not run. */
export function formatResultsTable(outcomes: TrialOutcome[], skipped: string[] = []): string {
    const lines: string[] = [];
    lines.push('='.repeat(100));
    lines.push('Workflow Evaluation Results');
    lines.push('='.repeat(100));
    lines.push('');

    for (const outcome of outcomes) {
        let status: string;
        if (outcome.reward === null) {
            status = '🔥 ERROR';
        } else if (isPass(outcome)) {
            status = '✅ PASS';
        } else {
            status = '❌ FAIL';
        }
        lines.push(`${status} | ${outcome.id}${outcome.category ? ` | ${outcome.category}` : ''}`);
        lines.push(`  Reason: ${outcome.reason}`);
        lines.push('');
    }

    for (const id of skipped) {
        lines.push(`⏭️  SKIPPED | ${id} (not supported by this harness)`);
    }
    if (skipped.length > 0) {
        lines.push('');
    }

    const { total, passed, failed, errored } = summarize(outcomes);
    lines.push('-'.repeat(100));
    lines.push('📊 Summary:');
    lines.push(`  Executed: ${total}`);
    lines.push(`  Passed: ${passed} ✅`);
    lines.push(`  Failed: ${failed} ❌`);
    lines.push(`  Errors: ${errored} 🔥`);
    if (skipped.length > 0) {
        lines.push(`  Skipped: ${skipped.length} ⏭️`);
    }
    lines.push('');

    if (total === 0) {
        lines.push('⚠️  No trials executed');
    } else if (passed === total) {
        lines.push(`✅ Overall: PASS (${passed}/${total} trials passed)`);
    } else {
        lines.push(`❌ Overall: FAIL (${passed}/${total} trials passed, ${failed} failed, ${errored} errors)`);
    }
    lines.push('='.repeat(100));

    return lines.join('\n');
}
