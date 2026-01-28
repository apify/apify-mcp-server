#!/usr/bin/env node
/*
 Dev orchestrator: runs web widget builder in watch mode and the MCP server in standby dev mode.
 Ensures the server always reads compiled assets from src/web/dist while enabling hot-reload.
*/

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const currentDir = dirname(filename);
const repoRoot = resolve(currentDir, '..');

function run(cmd, args, opts = {}) {
    const child = spawn(cmd, args, {
        stdio: 'inherit',
        env: { ...process.env, ...opts.env },
        cwd: opts.cwd || repoRoot,
        shell: process.platform === 'win32',
    });
    child.on('exit', (code) => {
        // If one process exits, exit the orchestrator with the same code.
        process.exitCode = code ?? 1;
    });
    return child;
}

// 1) Start web build in watch mode (produces src/web/dist)
const webDir = resolve(repoRoot, 'src/web');
const web = run('npm', ['run', 'dev', '--silent'], { cwd: webDir });

// 2) Start server in STANDBY dev mode (reads src/web/dist via resolveAvailableWidgets)
const server = run('npm', ['run', 'start:dev'], { env: { APIFY_META_ORIGIN: 'STANDBY' } });

// Forward signals so both children terminate cleanly
function shutdown() {
    try {
        web.kill('SIGINT');
    } catch {
        // ignore
    }
    try {
        server.kill('SIGINT');
    } catch {
        // ignore
    }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
