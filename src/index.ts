import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import minimist from 'minimist';

import { ApifyMcpServer } from './server.js';

const argv = minimist(process.argv.slice(2));
const argActors = argv.actors?.split(',').map((actor: string) => actor.trim()) || [];

async function main() {
    const server = new ApifyMcpServer();
    await (argActors.length !== 0
        ? server.addToolsFromActors(argActors)
        : server.addToolsFromDefaultActors());
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error); // eslint-disable-line no-console
    process.exit(1);
});
