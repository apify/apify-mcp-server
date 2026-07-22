import { createServer } from 'node:net';

/**
 * Finds an available port by letting the OS assign one dynamically, avoiding "address already
 * in use" flakes in tests.
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
