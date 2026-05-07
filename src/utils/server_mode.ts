import { SERVER_MODE_AUTO_DETECTION_ENABLED } from '../const.js';
import { ServerMode, type ServerModeOption } from '../types.js';

/**
 * Parse an untrusted raw mode string (from CLI flag, env var, or URL param) into a {@link ServerModeOption}.
 *
 * Accepts:
 * - `'default'` / `'apps'` — canonical values
 * - `'true'` / `'on'` / `'false'` / `'off'` — CLI shorthand
 * - `'auto'` — resolve from client capabilities (default for missing/unknown input)
 * - `'openai'` — deprecated alias for `'apps'` (pre-MCP-Apps naming); silently normalized
 *
 * Missing or unrecognized input returns `'auto'`, so a typo in an env var becomes
 * capability-driven resolution instead of silently forcing default mode.
 */
export function parseServerMode(rawMode: string | null | undefined): ServerModeOption {
    if (!rawMode) return 'auto';
    if (rawMode === 'true' || rawMode === 'on' || rawMode === ServerMode.APPS || rawMode === 'openai') return ServerMode.APPS;
    if (rawMode === 'false' || rawMode === 'off' || rawMode === ServerMode.DEFAULT) return ServerMode.DEFAULT;
    return 'auto';
}

/**
 * Resolve a {@link ServerModeOption} to a concrete {@link ServerMode}.
 * Concrete modes are returned as-is. `'auto'` resolves to {@link ServerMode.APPS}
 * when the client advertises MCP Apps UI support, {@link ServerMode.DEFAULT} otherwise.
 */
export function resolveServerMode(option: ServerModeOption, clientSupportsUi: boolean): ServerMode {
    if (option !== 'auto') return option;
    if (!SERVER_MODE_AUTO_DETECTION_ENABLED) return ServerMode.DEFAULT;
    return clientSupportsUi ? ServerMode.APPS : ServerMode.DEFAULT;
}
