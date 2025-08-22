#!/usr/bin/env node
/*
 This file provides essential functions and tools for MCP servers, serving as a library.
 The ActorsMcpServer should be the only class exported from the package
*/
export { ActorsMcpServer } from './mcp/server.js';

// Uncomment the following lines if you want run the server using: npx @smithery/cli build && npx @smithery/cli dev
// export { serverConfigSchemaSmithery as configSchema } from './types.js';
// export { default as smithery } from './smithery.js';

