/**
 * TEMPORARY — delete this whole directory when the stateless migration (#1128) closes.
 *
 * This is scaffolding, not a permanent suite. It exists to prove the v1 (legacy sessionful)
 * protocol surface is unchanged by that migration, by probing two builds and diffing the output.
 * `tests/integration/suite.ts` remains the permanent suite; do not migrate coverage into here,
 * and do not wire this into CI.
 *
 * See tests/e2e/README.md for how to run it and how to read a diff.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type McpcCase = {
    id: string;
    configs: string[];
    args: string[];
    /** Optional: cases without an assertion are snapshot-only, and just have to reach the server. */
    assert?: string;
    /** Expect a non-zero mcpc exit. Protocol errors exit 2 and write the payload to stderr. */
    expectError?: boolean;
    /** jq filters whose results are stored for `{{name}}` interpolation in later cases of the same config. */
    capture?: Record<string, string>;
    /** Run the snapshot through redact.jq. Needed for anything whose output embeds IDs or timings. */
    redact?: boolean;
};

type McpcServerConfig = {
    /** Arguments for the spawned stdio server. Ignored when `url` is set. */
    args?: string[];
    /** Connect to an HTTP endpoint instead of spawning a stdio server. */
    url?: string;
    /** Env overrides for the spawned server. A `null` value removes the variable. */
    env?: Record<string, string | null>;
};

type McpcSuiteConfig = {
    configs: Record<string, McpcServerConfig>;
    cases: McpcCase[];
};

const suite = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')) as McpcSuiteConfig;

/** mcpc is a devDependency, so it is only on PATH under `pnpm run`. Resolve it directly. */
const MCPC_BIN = resolve('node_modules/.bin/mcpc');

/** Point at another build (e.g. a pre-migration worktree) to compare behavior across commits. */
const SERVER_ENTRY = resolve(process.env.E2E_SERVER_ENTRY ?? 'dist/stdio.js');

/**
 * When set, every case writes its normalized output to `<dir>/<config>/<case>.json`. Capture two
 * builds via E2E_SERVER_ENTRY into two directories and `diff -r` them to find behavioral drift.
 */
const SNAPSHOT_DIR = process.env.E2E_SNAPSHOT_DIR;
const REDACT_FILTER = resolve('tests/e2e/redact.jq');

/** Base URL for HTTP configs, e.g. http://localhost:3001 with `pnpm run dev` running. */
const HTTP_BASE = process.env.E2E_HTTP_BASE;
const HTTP_BASE_TOKEN = '${E2E_HTTP_BASE}';

/** HTTP configs need a running server, so they are skipped unless E2E_HTTP_BASE is set. */
const activeConfigs = Object.entries(suite.configs).filter(
    ([, config]) => !config.url?.includes(HTTP_BASE_TOKEN) || Boolean(HTTP_BASE),
);

const DEFAULT_SERVER_ENV: Record<string, string | null> = {
    APIFY_TOKEN: '${APIFY_TOKEN}',
    NODE_EXTRA_CA_CERTS: '${NODE_EXTRA_CA_CERTS}',
};

/** Widget resources are ~1.5 MB of inlined HTML, well past spawnSync's 1 MB default. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Per-probe wall clock. Kept well under the vitest test timeout so a wedged mcpc bridge reports a
 * named failure instead of being killed anonymously by the runner. See README, "Known instability":
 * mcpc can hang indefinitely on a `tools/call` or `prompts/get` protocol error, returning no output
 * at all, in which case the probe must fail loudly rather than stall the suite.
 */
const PROBE_TIMEOUT_MS = Number(process.env.E2E_PROBE_TIMEOUT_MS ?? 45_000);

function runMcpc(args: string[], options: { allowFailure?: boolean } = {}) {
    const result = spawnSync(MCPC_BIN, args, {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: PROBE_TIMEOUT_MS,
    });

    // spawnSync reports a timeout kill as an ETIMEDOUT error with no usable output.
    if (result.error) {
        const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
        throw new Error(
            timedOut
                ? `mcpc ${args.join(' ')} produced no output within ${PROBE_TIMEOUT_MS}ms. ` +
                      'A hung bridge, not a server failure — see tests/e2e/README.md.'
                : `mcpc ${args.join(' ')} could not be run: ${result.error.message}`,
        );
    }
    if (!options.allowFailure && result.status !== 0) {
        throw new Error(`mcpc ${args.join(' ')} failed:\n${result.stderr}`);
    }

    return result;
}

function runJq(input: string, filter: string, options: { raw?: boolean } = {}) {
    const result = spawnSync('jq', [options.raw ? '-r' : '-e', filter], {
        input,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
    });
    if (result.error) throw result.error;
    return result;
}

/** Builds the mcpc server entry written to the temporary config file. */
function buildServerEntry(config: McpcServerConfig) {
    if (config.url) {
        const url = config.url.replace(HTTP_BASE_TOKEN, HTTP_BASE ?? '');
        return { type: 'http', url, headers: { Authorization: 'Bearer ${APIFY_TOKEN}' } };
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...DEFAULT_SERVER_ENV, ...config.env })) {
        if (value !== null) env[key] = value;
    }

    return { command: 'node', args: [SERVER_ENTRY, ...(config.args ?? [])], env };
}

function toSlug(id: string) {
    return id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * Removes mcpc's own `_mcpc` envelope. It carries the resolved APIFY_TOKEN in plaintext and the
 * absolute server path, so it must never reach a snapshot, an assertion or a failure message.
 */
function stripMcpcEnvelope(payload: string) {
    const result = spawnSync('jq', ['if type == "object" then del(._mcpc) else . end'], {
        input: payload,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
    });
    // Non-JSON output (an mcpc crash, say) has no envelope to strip — assert against it as-is.
    return result.status === 0 ? result.stdout : payload;
}

/** Normalizes a probe result with jq (sorted keys, optional redaction) and writes it for diffing. */
function writeSnapshot(directory: string, testCase: McpcCase, payload: string) {
    const file = join(directory, `${toSlug(testCase.id)}.json`);
    if (existsSync(file)) throw new Error(`Duplicate snapshot name for case "${testCase.id}"`);

    const normalized = spawnSync('jq', testCase.redact ? ['-S', '-f', REDACT_FILTER] : ['-S', '.'], {
        input: payload,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
    });
    if (normalized.error) throw normalized.error;
    if (normalized.status !== 0) {
        throw new Error(`jq failed to normalize the snapshot for "${testCase.id}":\n${normalized.stderr}`);
    }

    writeFileSync(file, normalized.stdout);
}

function interpolate(value: string, captured: Record<string, string>) {
    return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
        if (!(name in captured)) {
            throw new Error(`No captured value for {{${name}}}. Does an earlier case in this config capture it?`);
        }
        return captured[name];
    });
}

describe('mcpc', () => {
    beforeAll(() => {
        if (!existsSync(MCPC_BIN)) throw new Error(`mcpc not found at ${MCPC_BIN}. Run \`pnpm install\`.`);
        if (!existsSync(SERVER_ENTRY)) {
            throw new Error(`Server entry not found at ${SERVER_ENTRY}. Run \`pnpm run build\`.`);
        }
        const jq = spawnSync('jq', ['--version'], { encoding: 'utf8' });
        if (jq.error || jq.status !== 0) throw new Error('`jq` is required by this suite but was not found on PATH.');
    });

    describe.each(activeConfigs)('%s', (configName, config) => {
        const session = `@e2e-${configName}`;
        /** Values captured by earlier cases in this config, for `{{name}}` interpolation. */
        const captured: Record<string, string> = {};
        const snapshotDirectory = SNAPSHOT_DIR ? join(SNAPSHOT_DIR, configName) : undefined;
        let configDirectory: string;

        beforeAll(() => {
            if (snapshotDirectory) {
                // Start clean so a diff never mixes results from an earlier run.
                rmSync(snapshotDirectory, { recursive: true, force: true });
                mkdirSync(snapshotDirectory, { recursive: true });
            }

            configDirectory = mkdtempSync(join(tmpdir(), `actors-mcp-e2e-${configName}-`));
            const configPath = join(configDirectory, 'mcp.json');
            writeFileSync(configPath, JSON.stringify({ mcpServers: { server: buildServerEntry(config) } }));

            runMcpc(['close', session], { allowFailure: true });
            runMcpc(['connect', `${configPath}:server`, session]);
        });

        afterAll(() => {
            runMcpc(['close', session], { allowFailure: true });
            rmSync(configDirectory, { recursive: true, force: true });
        });

        it.each(suite.cases.filter((testCase) => testCase.configs.includes(configName)))('$id', (testCase) => {
            const args = testCase.args.map((arg) => interpolate(arg, captured));
            const result = runMcpc(['--json', session, ...args], { allowFailure: testCase.expectError });

            if (testCase.expectError && result.status === 0) {
                throw new Error(`Expected a non-zero exit for "${testCase.id}", got 0:\n${result.stdout}`);
            }

            // Protocol errors (exit 2) leave stdout empty and write the JSON payload to stderr.
            const payload = stripMcpcEnvelope(result.stdout.trim() || result.stderr);

            if (testCase.assert) {
                const assertion = runJq(payload, testCase.assert);
                expect(assertion.status, `Assertion failed: ${testCase.assert}\n${payload}`).toBe(0);
            }

            if (snapshotDirectory) writeSnapshot(snapshotDirectory, testCase, payload);

            for (const [name, filter] of Object.entries(testCase.capture ?? {})) {
                const value = runJq(payload, filter, { raw: true }).stdout.trim();
                if (!value || value === 'null') {
                    throw new Error(`Capture "${name}" (${filter}) produced no value in "${testCase.id}":\n${payload}`);
                }
                captured[name] = value;
            }
        });
    });
});
