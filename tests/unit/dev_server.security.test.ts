import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createExpressApp } from '../../src/dev_server.js';

describe('dev_server DNS rebinding protection', () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
        const app = createExpressApp();
        await new Promise<void>((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                port = typeof addr === 'object' && addr ? addr.port : 0;
                resolve();
            });
        });
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    async function makeRequest(headers: Record<string, string>): Promise<{ statusCode: number; body: string }> {
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: '/',
                    method: 'GET',
                    headers,
                },
                (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                    res.on('end', () => resolve({ statusCode: res.statusCode!, body }));
                },
            );
            req.on('error', reject);
            req.end();
        });
    }

    it('should accept requests with Host: localhost', async () => {
        const res = await makeRequest({ host: `localhost:${port}` });
        // Should not be 403 — the request passes host validation (may be 405 since GET / returns that)
        expect(res.statusCode).not.toBe(403);
    });

    it('should accept requests with Host: 127.0.0.1', async () => {
        const res = await makeRequest({ host: `127.0.0.1:${port}` });
        expect(res.statusCode).not.toBe(403);
    });

    it('should reject requests with Host: evil.com', async () => {
        const res = await makeRequest({ host: 'evil.com' });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error.message).toContain('Invalid Host');
    });

    it('should reject requests with a spoofed Host header', async () => {
        const res = await makeRequest({ host: 'attacker.example.com:3001' });
        expect(res.statusCode).toBe(403);
    });
});
