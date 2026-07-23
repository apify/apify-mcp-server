/*
 This file provides essential functions and tools for MCP servers, serving as a library.
 Intentional public surface: the `ActorsMcpServer` class (legacy v1 serving) and the
 `createServer2` factory (modern 2026-07-28 serving shell). Keep this the whole export list.
*/

import { ActorsMcpServer } from './mcp/server.js';
import { createServer2 } from './mcp/server2.js';

export { ActorsMcpServer, createServer2 };
