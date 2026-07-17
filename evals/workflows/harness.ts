/**
 * Harness selection and `opik harbor run` argument mapping.
 *
 * Two swappable agent harnesses run the same generated tasks:
 * - claude-code: Harbor's built-in agent (default), unrestricted toolset.
 * - ts-executor: a custom Harbor agent wrapping the existing TypeScript conversation executor.
 *
 * The functions here are pure so the flag/env mapping is unit-testable without Docker.
 */

import { MODELS } from './config.js';

/** The two agent harnesses. claude-code is the default. */
export const HARNESS = {
    CLAUDE_CODE: 'claude-code',
    TS_EXECUTOR: 'ts-executor',
} as const;
export type HARNESS = (typeof HARNESS)[keyof typeof HARNESS];

/**
 * Default agent model per harness. Harbor's claude-code agent sets
 * `ANTHROPIC_MODEL = model.split('/')[-1]` and calls the native Anthropic API, which expects the
 * dash-form id (`claude-haiku-4-5`), not the dotted OpenRouter slug. ts-executor talks to
 * OpenRouter and uses the slug. An explicit --agent-model overrides either verbatim.
 */
export const DEFAULT_AGENT_MODELS = {
    [HARNESS.CLAUDE_CODE]: 'claude-haiku-4-5',
    [HARNESS.TS_EXECUTOR]: MODELS.agent,
} as const;

/** Resolve the agent model: an explicit value wins, else the harness default. */
export function resolveAgentModel(harness: HARNESS, explicitModel?: string): string {
    return explicitModel ?? DEFAULT_AGENT_MODELS[harness];
}

/**
 * Import path of the custom ts-executor Harbor agent, passed to `harbor run -a`.
 * Harbor's `-a` accepts either a built-in agent name or a `module:ClassName` import path.
 * Resolvable because the orchestrator runs the wrapper with the harbor sub-package on PYTHONPATH.
 */
export const TS_EXECUTOR_AGENT_IMPORT_PATH = 'ts_executor_agent:TsExecutorAgent';

/** Env var carrying the judge model into the verifier container (via `--ve`). */
export const ENV_JUDGE_MODEL = 'EVAL_JUDGE_MODEL';

/** Env var carrying the tool-call timeout (seconds) into containers (via `--ae`/`--ve`). */
export const ENV_TOOL_TIMEOUT_SECONDS = 'EVAL_TOOL_TIMEOUT_SECONDS';

/** Resolve the `harbor run -a` value for a harness. */
export function resolveHarborAgent(harness: HARNESS): string {
    return harness === HARNESS.TS_EXECUTOR ? TS_EXECUTOR_AGENT_IMPORT_PATH : HARNESS.CLAUDE_CODE;
}

export type HarborRunArgsOptions = {
    harness: HARNESS;
    tasksDir: string;
    jobsDir: string;
    agentModel: string;
    concurrency: number;
};

/**
 * Build the structural `harbor run` arguments (no secrets). `-p` points at the generated
 * task dataset dir, `-n` maps to our --concurrency, `-y` auto-confirms the host-access prompt.
 */
export function buildHarborRunArgs(options: HarborRunArgsOptions): string[] {
    const { harness, tasksDir, jobsDir, agentModel, concurrency } = options;
    return [
        'run',
        '-p',
        tasksDir,
        '-o',
        jobsDir,
        '-e',
        'docker',
        '-a',
        resolveHarborAgent(harness),
        '-m',
        agentModel,
        '-n',
        String(concurrency),
        '-y',
    ];
}

export type EnvPassthroughOptions = {
    harness: HARNESS;
    apifyToken: string;
    openrouterKey: string;
    anthropicKey?: string;
    judgeModel: string;
    toolTimeoutSeconds: number;
};

/**
 * Build the `--ae` (agent-env) and `--ve` (verifier-env) passthrough flags.
 * Agent needs APIFY_TOKEN + OPENROUTER_API_KEY (and ANTHROPIC_API_KEY for claude-code) plus the
 * tool timeout. Verifier needs OPENROUTER_API_KEY + the judge model (the judge makes one LLM call
 * and does not run MCP tools, so it does not need the tool timeout).
 */
export function buildEnvPassthroughArgs(options: EnvPassthroughOptions): string[] {
    const { harness, apifyToken, openrouterKey, anthropicKey, judgeModel, toolTimeoutSeconds } = options;

    const args = [
        '--ae',
        `APIFY_TOKEN=${apifyToken}`,
        '--ae',
        `OPENROUTER_API_KEY=${openrouterKey}`,
        '--ae',
        `${ENV_TOOL_TIMEOUT_SECONDS}=${String(toolTimeoutSeconds)}`,
    ];

    if (harness === HARNESS.CLAUDE_CODE && anthropicKey) {
        args.push('--ae', `ANTHROPIC_API_KEY=${anthropicKey}`);
    }

    args.push('--ve', `OPENROUTER_API_KEY=${openrouterKey}`, '--ve', `${ENV_JUDGE_MODEL}=${judgeModel}`);

    return args;
}
