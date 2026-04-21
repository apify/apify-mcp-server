/**
 * Server instructions entry point. Unified across all modes — widget-specific
 * guidance is inert for clients without the MCP Apps UI capability because
 * `-widget` tool names never appear in their `tools/list`.
 */

import { getCommonInstructions } from './common.js';

/**
 * Build unified server instructions. Mode-agnostic.
 */
export function getServerInstructions(): string {
    return getCommonInstructions();
}
