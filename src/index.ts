/*
 This file provides essential functions and tools for MCP servers, serving as a library.
 Intentional public surface: the `ActorsMcpServer` class (legacy v1 serving) and the
 `createStatelessServer` factory (MCP 2026-07-28 serving shell). Keep this the whole export list.
*/

import { ActorsMcpServer } from './mcp/server.js';
import { createStatelessServer } from './mcp/stateless_server.js';

export { ActorsMcpServer, createStatelessServer };
