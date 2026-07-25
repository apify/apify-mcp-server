import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type McpcCase = {
    id: string;
    configs: string[];
    args: string[];
    assert: string;
    /** Expect a non-zero mcpc exit. Protocol errors exit 2 and write the payload to stderr. */
    expectError?: boolean;
    /** jq filters whose results are stored for `{{name}}` interpolation in later cases of the same config. */
    capture?: Record<string, string>;
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

const DEFAULT_SERVER_ENV: Record<string, string | null> = {
    APIFY_TOKEN: '${APIFY_TOKEN}',
    NODE_EXTRA_CA_CERTS: '${NODE_EXTRA_CA_CERTS}',
};

function runMcpc(args: string[], options: { allowFailure?: boolean } = {}) {
    const result = spawnSync(MCPC_BIN, args, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
    });

    if (result.error) throw result.error;
    if (!options.allowFailure && result.status !== 0) {
        throw new Error(`mcpc ${args.join(' ')} failed:\n${result.stderr}`);
    }

    return result;
}

function runJq(input: string, filter: string, options: { raw?: boolean } = {}) {
    const result = spawnSync('jq', [options.raw ? '-r' : '-e', filter], { input, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
}

/** Builds the mcpc server entry written to the temporary config file. */
function buildServerEntry(config: McpcServerConfig) {
    if (config.url) {
        return { type: 'http', url: config.url, headers: { Authorization: 'Bearer ${APIFY_TOKEN}' } };
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...DEFAULT_SERVER_ENV, ...config.env })) {
        if (value !== null) env[key] = value;
    }

    return { command: 'node', args: [SERVER_ENTRY, ...(config.args ?? [])], env };
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

    describe.each(Object.entries(suite.configs))('%s', (configName, config) => {
        const session = `@e2e-${configName}`;
        /** Values captured by earlier cases in this config, for `{{name}}` interpolation. */
        const captured: Record<string, string> = {};
        let configDirectory: string;

        beforeAll(() => {
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
            const payload = result.stdout.trim() || result.stderr;

            const assertion = runJq(payload, testCase.assert);
            expect(assertion.status, `Assertion failed: ${testCase.assert}\n${payload}`).toBe(0);

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
