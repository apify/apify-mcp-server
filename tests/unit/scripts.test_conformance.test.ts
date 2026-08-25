/** scripts/test_conformance.sh: token redaction and exit-status preservation. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Contains a character ("+") that changes under encodeURIComponent, so the raw- and
// encoded-token assertions are actually distinct.
const FAKE_TOKEN = 'abc+def/123';
const FAKE_TOKEN_ENCODED = encodeURIComponent(FAKE_TOKEN);

let stubDir: string;

/** Runs the real script with a stub `pnpm` on PATH so no real build/conformance call happens. */
function runScript(stubExitCode: number) {
    const stubPnpm = join(stubDir, 'pnpm');
    writeFileSync(
        stubPnpm,
        `#!/usr/bin/env bash
if [[ "$1 $2" == "run build" ]]; then
    exit 0
fi
if [[ "$1 $2" == "exec conformance" ]]; then
    echo "connecting to http://127.0.0.1:\${PORT}/?token=${FAKE_TOKEN}"
    echo "encoded=${FAKE_TOKEN_ENCODED}" >&2
    exit ${stubExitCode}
fi
exit 1
`,
    );
    chmodSync(stubPnpm, 0o755);

    return spawnSync('bash', ['scripts/test_conformance.sh'], {
        cwd: process.cwd(),
        env: { ...process.env, APIFY_TOKEN: FAKE_TOKEN, PATH: `${stubDir}:${process.env.PATH}` },
        encoding: 'utf8',
    });
}

describe('test_conformance.sh', () => {
    beforeEach(() => {
        stubDir = mkdtempSync(join(tmpdir(), 'conformance-stub-'));
    });

    afterEach(() => {
        rmSync(stubDir, { recursive: true, force: true });
    });

    it('redacts the raw and percent-encoded token and preserves a successful exit code', () => {
        const result = runScript(0);
        const output = result.stdout + result.stderr;

        expect(output).not.toContain(FAKE_TOKEN);
        expect(output).not.toContain(FAKE_TOKEN_ENCODED);
        expect(result.status).toBe(0);
    });

    it('redacts the token on a failing run and preserves the modern suite exit code', () => {
        const result = runScript(5);
        const output = result.stdout + result.stderr;

        expect(output).not.toContain(FAKE_TOKEN);
        expect(output).not.toContain(FAKE_TOKEN_ENCODED);
        expect(result.status).toBe(5);
    });
});
