import { createServer } from 'node:net';

/**
 * Finds an available port by letting the OS assign one dynamically.
 * This is to prevent the address already in use errors to prevent flaky tests.
 * @returns Promise<number> - An available port assigned by the OS
 */
export async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}
