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

// awk's `-v` assignment backslash-escape-processes its value (POSIX), which previously let a
// token containing a literal backslash bypass redaction entirely.
const BACKSLASH_TOKEN = 'abc\\ndef';
const BACKSLASH_TOKEN_ENCODED = encodeURIComponent(BACKSLASH_TOKEN);

let stubDir: string;

const STUB_PNPM = `#!/usr/bin/env bash
if [[ "$1 $2" == "run build" ]]; then
    exit 0
fi
if [[ "$1 $2" == "exec conformance" ]]; then
    spec_version=""
    prev=""
    for arg in "$@"; do
        if [[ "$prev" == "--spec-version" ]]; then
            spec_version="$arg"
        fi
        prev="$arg"
    done
    echo "connecting to http://127.0.0.1:\${PORT}/?token=\${STUB_TOKEN}"
    echo "encoded=\${STUB_TOKEN_ENCODED}" >&2
    if [[ "$spec_version" == "2026-07-28" ]]; then
        exit "\${STUB_MODERN_EXIT}"
    fi
    exit "\${STUB_LEGACY_EXIT}"
fi
exit 1
`;

/** Runs the real script with a stub `pnpm` on PATH so no real build/conformance call happens. */
function runScript(opts: { token: string; encoded: string; modernExit: number; legacyExit: number }) {
    const stubPnpm = join(stubDir, 'pnpm');
    writeFileSync(stubPnpm, STUB_PNPM);
    chmodSync(stubPnpm, 0o755);

    return spawnSync('bash', ['scripts/test_conformance.sh'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            APIFY_TOKEN: opts.token,
            STUB_TOKEN: opts.token,
            STUB_TOKEN_ENCODED: opts.encoded,
            STUB_MODERN_EXIT: String(opts.modernExit),
            STUB_LEGACY_EXIT: String(opts.legacyExit),
            PATH: `${stubDir}:${process.env.PATH}`,
        },
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

    it('redacts the token and leaves surrounding output intact when both suites pass', () => {
        const result = runScript({ token: FAKE_TOKEN, encoded: FAKE_TOKEN_ENCODED, modernExit: 0, legacyExit: 0 });
        const output = result.stdout + result.stderr;

        expect(output).not.toContain(FAKE_TOKEN);
        expect(output).not.toContain(FAKE_TOKEN_ENCODED);
        expect(output).toContain('***REDACTED***');
        expect(output).toContain('connecting to http://127.0.0.1');
        expect(result.status).toBe(0);
    });

    it('redacts a token containing a literal backslash', () => {
        const result = runScript({
            token: BACKSLASH_TOKEN,
            encoded: BACKSLASH_TOKEN_ENCODED,
            modernExit: 0,
            legacyExit: 0,
        });
        const output = result.stdout + result.stderr;

        expect(output).not.toContain(BACKSLASH_TOKEN);
        expect(output).not.toContain(BACKSLASH_TOKEN_ENCODED);
        expect(output).toContain('***REDACTED***');
        expect(result.status).toBe(0);
    });

    it('exits with the modern suite status when only the modern suite fails', () => {
        const result = runScript({ token: FAKE_TOKEN, encoded: FAKE_TOKEN_ENCODED, modernExit: 5, legacyExit: 0 });

        expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
        expect(result.status).toBe(5);
    });

    it('exits with the legacy suite status when only the legacy suite fails', () => {
        const result = runScript({ token: FAKE_TOKEN, encoded: FAKE_TOKEN_ENCODED, modernExit: 0, legacyExit: 7 });

        expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
        expect(result.status).toBe(7);
    });

    it('prefers the modern suite status when both suites fail', () => {
        const result = runScript({ token: FAKE_TOKEN, encoded: FAKE_TOKEN_ENCODED, modernExit: 5, legacyExit: 7 });

        expect(result.status).toBe(5);
    });
});
