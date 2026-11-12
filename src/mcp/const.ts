import { MAX_REQUEST_BODY_BYTES } from '../const.js';

export const MCP_STREAMABLE_ENDPOINT = '/mcp';

export const MAX_TOOL_NAME_LENGTH = 64;
export const MAX_TOOL_NAME_USERNAME_LENGTH = 8;
export const TOOL_NAME_HASH_LENGTH = 4;
export const SERVER_ID_LENGTH = 8;
export const EXTERNAL_TOOL_CALL_TIMEOUT_MSEC = 120_000; // 2 minutes
export const ACTORIZED_MCP_CONNECTION_TIMEOUT_MSEC = 30_000; // 30 seconds
/**
 * Response bytes read from an Actor's MCP server over one connection: `initialize` plus one tool call, or plus every
 * page of one tool listing. Counted while the bodies are read, after decompression. It is the largest request body
 * this server accepts from its own clients, and far more than a model context takes.
 */
export const MAX_ACTOR_MCP_RESPONSE_BYTES = MAX_REQUEST_BODY_BYTES;

export const LOG_LEVEL_MAP: Record<string, number> = {
    debug: 0,
    info: 1,
    notice: 2,
    warning: 3,
    error: 4,
    critical: 5,
    alert: 6,
    emergency: 7,
};
