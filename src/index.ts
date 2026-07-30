/*
 This file provides essential functions and tools for MCP servers, serving as a library.
 Keep this surface minimal: the `ActorsMcpServer` facade, plus `createStatelessServer` — the
 per-request registration a host needs to serve 2026-07-28 traffic from one facade.
*/

import { ActorsMcpServer } from './mcp/server.js';
import { createStatelessServer } from './mcp/stateless_server.js';

export { ActorsMcpServer, createStatelessServer };
