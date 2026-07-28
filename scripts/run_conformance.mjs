#!/usr/bin/env node
// Runs the official MCP conformance suite against the dev server for both protocol eras:
// build once → boot the compiled dev server once on a free port → wait for the port → run the
// runner twice against that same URL (2026-07-28, then 2025-11-25), each with its own
// expected-failures ledger → tear the server down once → exit with the first non-zero runner code.
// The endpoint discriminates the era per request, so there is no second server and no toggle.
//
// The runner has no header flag and the dev server accepts only an `Authorization` header or
// `?token=` (no APIFY_TOKEN fallback), so the token must ride the URL — and the runner echoes that
// URL to stdout. Every child's stdout/stderr is therefore piped through a redactor, not inherited.
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One ledger per era. The failure sets genuinely differ — the 2026 era fails on stateless-adapter
// and discover behavior, the legacy era on session and SSE scenarios — so a shared file could not
// tell "expected failure in this era" from "stale entry in that era".
const ERAS = [
    {
        specVersion: '2026-07-28',
        expectedFailuresFile: 'scripts/conformance_expected_failures_2026_07_28.yaml',
    },
    {
        specVersion: '2025-11-25',
        expectedFailuresFile: 'scripts/conformance_expected_failures_2025_11_25.yaml',
    },
];
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;
const DEV_SERVER_CLOSE_TIMEOUT_MS = 5_000;
const TOKEN_PLACEHOLDER = '<APIFY_TOKEN>';

/** Both spellings the token can take in child output: raw, and percent-encoded. */
function getTokenSpellings() {
    const token = process.env.APIFY_TOKEN ?? '';
    if (token === '') return [];
    return [...new Set([token, encodeURIComponent(token)])];
}

/**
 * Line-buffered redacting writer. A chunk boundary can split the token in half, so everything
 * after the last newline is held back until the rest of its line arrives; `flush()` releases a
 * trailing partial line once the stream ends.
 */
function createRedactingWriter(target, secrets) {
    let pending = '';
    const redact = (text) => secrets.reduce((acc, secret) => acc.replaceAll(secret, TOKEN_PLACEHOLDER), text);
    return {
        write(chunk) {
            pending += chunk;
            const lastNewline = pending.lastIndexOf('\n');
            if (lastNewline === -1) return;
            target.write(redact(pending.slice(0, lastNewline + 1)));
            pending = pending.slice(lastNewline + 1);
        },
        flush() {
            if (pending === '') return;
            target.write(redact(pending));
            pending = '';
        },
    };
}

/** Forwards a piped child's output to ours with the token redacted. Returns the flush callback. */
function forwardRedacted(child) {
    const secrets = getTokenSpellings();
    const stdout = createRedactingWriter(process.stdout, secrets);
    const stderr = createRedactingWriter(process.stderr, secrets);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => stdout.write(chunk));
    child.stderr?.on('data', (chunk) => stderr.write(chunk));
    return () => {
        stdout.flush();
        stderr.flush();
    };
}

async function runToCompletion(command, args, env = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
            cwd: repoRoot,
            shell: process.platform === 'win32',
        });
        const flush = forwardRedacted(child);
        child.on('error', (error) => {
            flush();
            rejectPromise(error);
        });
        // `close`, not `exit`: with piped stdio the streams can still hold unread output at `exit`.
        child.on('close', (code) => {
            flush();
            resolvePromise(code ?? 1);
        });
    });
}

// Duplicates `getAvailablePort()` in `tests/integration/utils/port.ts`: this script is plain
// pre-build `.mjs` run by `node`, that helper is TypeScript only consumable through vitest/tsx.
async function getFreePort() {
    return new Promise((resolvePromise, rejectPromise) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolvePromise(port));
        });
        server.on('error', rejectPromise);
    });
}

// The dev server has no health endpoint and its "listening" log line can be silenced by log-level
// config, so readiness is a TCP connect — the same signal the conformance README's CI recipe polls.
async function canConnect(port) {
    return new Promise((resolvePromise) => {
        const socket = connect({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
            socket.destroy();
            resolvePromise(true);
        });
        socket.once('error', () => {
            socket.destroy();
            resolvePromise(false);
        });
    });
}

async function waitForPort(port, isAborted) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (isAborted()) return false;
        if (await canConnect(port)) return true;
        await new Promise((resolvePromise) => {
            setTimeout(resolvePromise, READY_POLL_INTERVAL_MS);
        });
    }
    return false;
}

let devServer;
let devServerClosed;

/**
 * Kills the dev server and waits for its `close`, so what its pipes still hold — its own
 * "shutting down gracefully" line included — drains through the redactor before we exit. The `kill`
 * is synchronous, so the signal handlers below can call this without awaiting and still stop the
 * child.
 *
 * Escalates to `SIGKILL` instead of only timing out: `SIGKILL` closes the child's pipes, so `close`
 * does arrive and nothing is left running behind us. Both waits are bounded, so a child wedged past
 * even that cannot hang the command.
 */
async function stopDevServer() {
    if (devServer === undefined) return;
    for (const signal of ['SIGINT', 'SIGKILL']) {
        devServer.kill(signal);
        let timer;
        const isClosed = await Promise.race([
            devServerClosed.then(() => true),
            new Promise((resolvePromise) => {
                timer = setTimeout(() => resolvePromise(false), DEV_SERVER_CLOSE_TIMEOUT_MS);
            }),
        ]);
        clearTimeout(timer);
        if (isClosed) return;
    }
}

async function main() {
    if (!process.env.APIFY_TOKEN) {
        process.stderr.write('APIFY_TOKEN is not set — the dev server answers 401 to every request without it.\n');
        return 1;
    }

    const buildCode = await runToCompletion('pnpm', ['run', 'build']);
    if (buildCode !== 0) return buildCode;

    // 3001 is the dev server's default and `.mcp.json`'s `dev` address, so it collides with a
    // running `pnpm start` — take an OS-assigned port unless PORT says otherwise.
    const port = Number(process.env.PORT) || (await getFreePort());
    devServer = spawn('node', ['dist/dev_server.js'], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port) },
        cwd: repoRoot,
    });
    const flushDevServer = forwardRedacted(devServer);
    devServerClosed = new Promise((resolvePromise) => {
        devServer.once('close', () => {
            flushDevServer();
            resolvePromise();
        });
    });
    // Same `error` handling the other two children get. Without a listener Node throws on `error`,
    // and that throw escapes the try/finally below, so teardown would never run.
    let spawnError;
    devServer.on('error', (error) => {
        spawnError = error;
    });

    try {
        if (!(await waitForPort(port, () => spawnError !== undefined))) {
            process.stderr.write(
                spawnError
                    ? `Failed to start the dev server: ${spawnError.message}\n`
                    : `Dev server did not accept connections on port ${port} within ${READY_TIMEOUT_MS}ms.\n`,
            );
            return 1;
        }

        const url = `http://127.0.0.1:${port}/?token=${process.env.APIFY_TOKEN}`;
        const codes = [];
        // Both eras always run, in series: a failing first era must not hide the second's result.
        for (const { specVersion, expectedFailuresFile } of ERAS) {
            process.stdout.write(`\n=== Conformance: spec version ${specVersion} ===\n`);
            codes.push(
                await runToCompletion('pnpm', [
                    'exec',
                    'conformance',
                    'server',
                    '--url',
                    url,
                    '--suite',
                    'all',
                    '--spec-version',
                    specVersion,
                    '--expected-failures',
                    expectedFailuresFile,
                ]),
            );
        }

        process.stdout.write('\nConformance summary:\n');
        ERAS.forEach(({ specVersion }, index) => {
            const code = codes[index];
            process.stdout.write(`  ${specVersion}: ${code === 0 ? 'PASS' : `FAIL (exit ${code})`}\n`);
        });
        return codes.find((code) => code !== 0) ?? 0;
    } finally {
        await stopDevServer();
    }
}

// `void`, not `await`: these handlers exit immediately, and the `kill` inside `stopDevServer()` runs
// before its first `await`, so the child still gets the signal.
process.on('SIGINT', () => {
    void stopDevServer();
    process.exit(1);
});
process.on('SIGTERM', () => {
    void stopDevServer();
    process.exit(1);
});

const exitCode = await main();
// Child output now flows through this process instead of an inherited fd, and writes to a piped
// stdout (CI) are async — so drain before exiting or the tail, including the per-era summary, is
// lost. Explicit exit rather than `process.exitCode`: a dev server that outlived even the `SIGKILL`
// in `stopDevServer()` would otherwise keep the event loop alive and hang the command.
await new Promise((resolvePromise) => {
    process.stdout.write('', () => resolvePromise());
});
process.exit(exitCode);
