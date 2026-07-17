#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Harbor verifier entrypoint. The shared LLM judge, run in-container after the agent.
 *
 * Reads the ATIF trajectory the agent left at /logs/agent/trajectory.json (harness-agnostic:
 * ts-executor writes it directly, Harbor writes it for claude-code) plus the per-case reference,
 * reconstructs the conversation, and reuses workflow_judge.ts UNCHANGED. Emits the Harbor reward
 * (1 = PASS, 0 = FAIL) and prints the judge's reason to stdout, which Harbor captures.
 *
 * Args: --trajectory <path>  --case <path>  --reward-json <path>
 * Env:  OPENROUTER_API_KEY, EVAL_JUDGE_MODEL
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { atifToConversation } from './atif.js';
import type { AtifTrajectory } from './atif.js';
import { MODELS } from './config.js';
import { ENV_JUDGE_MODEL } from './harness.js';
import { LlmClient } from './llm_client.js';
import type { WorkflowTestCase } from './test_cases_loader.js';
import { evaluateConversation } from './workflow_judge.js';

type CaseFile = { id: string; category: string; reference: string };

/** Read a `--flag value` pair from argv. */
function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index !== -1 ? process.argv[index + 1] : undefined;
}

/** Write the reward file (1D convention: {"reward": 0|1}) and print the verdict/reason. */
function emitResult(rewardJsonPath: string, verdict: 'PASS' | 'FAIL', reason: string): void {
    mkdirSync(path.dirname(rewardJsonPath), { recursive: true });
    writeFileSync(rewardJsonPath, JSON.stringify({ reward: verdict === 'PASS' ? 1 : 0 }));
    console.log(`VERDICT: ${verdict}`);
    console.log(`REASON: ${reason}`);
}

async function main() {
    const trajectoryPath = readArg('--trajectory');
    const casePath = readArg('--case');
    const rewardJsonPath = readArg('--reward-json');
    if (!trajectoryPath || !casePath || !rewardJsonPath) {
        throw new Error('--trajectory, --case, and --reward-json are all required');
    }

    const judgeModel = process.env[ENV_JUDGE_MODEL] || MODELS.judge;
    const caseFile = JSON.parse(readFileSync(casePath, 'utf8')) as CaseFile;

    try {
        const trajectory = JSON.parse(readFileSync(trajectoryPath, 'utf8')) as AtifTrajectory;
        const conversation = atifToConversation(trajectory);

        const testCase: WorkflowTestCase = {
            id: caseFile.id,
            category: caseFile.category,
            query: conversation.userPrompt,
            reference: caseFile.reference,
        };

        const judgeResult = await evaluateConversation(testCase, conversation, new LlmClient(), judgeModel);
        emitResult(rewardJsonPath, judgeResult.verdict, judgeResult.reason);
    } catch (error) {
        // Any failure (missing trajectory, judge error) is a FAIL with reward 0, never a
        // missing reward file that would crash the trial.
        const message = error instanceof Error ? error.message : String(error);
        emitResult(rewardJsonPath, 'FAIL', `Verifier error: ${message}`);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
});
