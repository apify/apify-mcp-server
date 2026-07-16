/**
 * Opik integration helpers for workflow evaluations (self-hosted Opik).
 * Client factory, server preflight, git metadata, and experiment/dataset naming.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { Opik } from 'opik';

import { OPIK_CONFIG } from './config.js';
import type { WorkflowTestCase } from './test_cases_loader.js';

/** How to start a local Opik server, shown when the preflight ping fails. */
export const OPIK_START_HINT = 'git clone https://github.com/comet-ml/opik.git && cd opik && ./opik.sh';

/**
 * Dataset item shape stored in the `workflow-evals` dataset (mirrors the test case).
 * `id` is a deterministic UUID derived from the test-case id (the Opik backend requires UUID
 * item ids); `testId` carries the human-readable test-case id.
 */
export type WorkflowDatasetItem = {
    id: string;
    testId: string;
    category: string;
    query: string;
    reference: string;
    maxTurns?: number;
    tools?: string[];
    failTools?: string[];
};

/** Build an Opik client from the resolved config (local server by default). */
export function createOpikClient(): Opik {
    return new Opik({ ...OPIK_CONFIG });
}

/**
 * Ping the Opik server's is-alive endpoint. Returns true if the server responds, false if the
 * connection fails (server down). A fresh fetch avoids the SDK swallowing connection errors.
 */
export async function pingOpikServer(baseUrl: string = OPIK_CONFIG.apiUrl, timeoutMs = 3000): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        await fetch(`${baseUrl}/is-alive/ping`, { signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

/** Read the current git branch and commit SHA. Fields are omitted when git is unavailable. */
export function getGitMetadata(): { branch?: string; commit?: string } {
    const run = (args: string[]): string | undefined => {
        try {
            return execFileSync('git', args, { encoding: 'utf8' }).trim() || undefined;
        } catch {
            return undefined;
        }
    };
    return {
        branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
        commit: run(['rev-parse', 'HEAD']),
    };
}

/** Strip the provider prefix from a model id (e.g. "anthropic/claude-haiku-4.5" -> "claude-haiku-4.5"). */
export function shortModelName(model: string): string {
    const slash = model.indexOf('/');
    return slash === -1 ? model : model.slice(slash + 1);
}

/** Replace characters not allowed in an experiment-name segment with "-". */
export function sanitizeExperimentSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Build the experiment name `<git-branch>/<agent-model-short>`
 * (e.g. "feat-opik-evals/claude-haiku-4.5"). Branch chars are sanitized; falls back to "local".
 */
export function buildExperimentName(branch: string | undefined, agentModel: string): string {
    const branchPart = sanitizeExperimentSegment(branch || 'local');
    return `${branchPart}/${shortModelName(agentModel)}`;
}

/** Fixed namespace for deriving dataset item ids from test-case ids. */
const DATASET_ITEM_NAMESPACE = '7f3c9e2a4b8d4c1e9a6f2d5b8c7e1f04';

/**
 * Deterministic dataset item id for a test-case id. The Opik backend requires version 7 UUID
 * item ids, so this hashes the test id (SHA-1, namespaced) and stamps the v7 version/variant
 * bits — the "timestamp" bits are hash-derived, which is fine for an opaque id. A stable id
 * makes insert() an in-place upsert when a test case's content changes.
 */
export function testCaseItemId(testId: string): string {
    const hash = createHash('sha1').update(Buffer.from(DATASET_ITEM_NAMESPACE, 'hex')).update(testId).digest();
    /* eslint-disable no-bitwise */
    hash[6] = (hash[6] & 0x0f) | 0x70; // version 7
    hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
    /* eslint-enable no-bitwise */
    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Map a test case to its dataset item (item id derived via testCaseItemId). */
export function toDatasetItem(testCase: WorkflowTestCase): WorkflowDatasetItem {
    return {
        id: testCaseItemId(testCase.id),
        testId: testCase.id,
        category: testCase.category,
        query: testCase.query,
        reference: testCase.reference ?? '',
        ...(testCase.maxTurns !== undefined ? { maxTurns: testCase.maxTurns } : {}),
        ...(testCase.tools ? { tools: testCase.tools } : {}),
        ...(testCase.failTools ? { failTools: testCase.failTools } : {}),
    };
}
