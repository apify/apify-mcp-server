import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type McpcCase = {
    id: string;
    configs: string[];
    args: string[];
    assert: string;
};

type McpcSuiteConfig = {
    configs: Record<string, string[]>;
    cases: McpcCase[];
};

const suite = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')) as McpcSuiteConfig;

function runMcpc(args: string[], options: { allowFailure?: boolean; input?: string } = {}) {
    const result = spawnSync('mcpc', args, {
        input: options.input,
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

describe('mcpc', () => {
    describe.each(Object.entries(suite.configs))('%s', (configName, serverArgs) => {
        const session = `@e2e-${configName}`;
        let configDirectory: string;

        beforeAll(() => {
            configDirectory = mkdtempSync(join(tmpdir(), `actors-mcp-e2e-${configName}-`));
            const configPath = join(configDirectory, 'mcp.json');
            writeFileSync(
                configPath,
                JSON.stringify({
                    mcpServers: {
                        server: {
                            command: 'node',
                            args: [resolve('dist/stdio.js'), ...serverArgs],
                            env: {
                                APIFY_TOKEN: '${APIFY_TOKEN}',
                                NODE_EXTRA_CA_CERTS: '${NODE_EXTRA_CA_CERTS}',
                            },
                        },
                    },
                }),
            );

            runMcpc(['close', session], { allowFailure: true });
            runMcpc(['connect', `${configPath}:server`, session]);
        });

        afterAll(() => {
            runMcpc(['close', session], { allowFailure: true });
            rmSync(configDirectory, { recursive: true, force: true });
        });

        it.each(suite.cases.filter((testCase) => testCase.configs.includes(configName)))('$id', (testCase) => {
            const result = runMcpc(['--json', session, ...testCase.args]);
            const assertion = spawnSync('jq', ['-e', testCase.assert], {
                input: result.stdout,
                encoding: 'utf8',
            });

            expect(assertion.status, `Assertion failed: ${testCase.assert}\n${result.stdout}`).toBe(0);
        });
    });
});
