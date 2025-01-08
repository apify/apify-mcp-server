import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ApifyMcpServer } from './server.js';

const argActors = process.argv.find((arg) => arg.startsWith('ACTORS='))?.split('=')[1];

async function main() {
    const server = new ApifyMcpServer();

    if (argActors) {
        if (argActors && typeof argActors === 'string') {
            const actors = argActors.split(',').map((format: string) => format.trim()) as string[];
            await server.addToolsFromActors(actors);
        }
    } else {
        await server.addToolsFromDefaultActors();
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error); // eslint-disable-line no-console
    process.exit(1);
});
