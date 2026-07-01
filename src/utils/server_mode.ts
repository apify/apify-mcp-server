import { SERVER_MODE_AUTO_DETECTION_ENABLED } from '../const.js';
import { SERVER_MODE, type ServerModeOption } from '../types.js';

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
    if (rawMode === 'true' || rawMode === 'on' || rawMode === SERVER_MODE.APPS || rawMode === 'openai')
        return SERVER_MODE.APPS;
    if (rawMode === 'false' || rawMode === 'off' || rawMode === SERVER_MODE.DEFAULT) return SERVER_MODE.DEFAULT;
    return 'auto';
}

/**
 * Resolve a {@link ServerModeOption} to a concrete {@link SERVER_MODE}.
 * Concrete modes are returned as-is. `'auto'` resolves to {@link SERVER_MODE.APPS}
 * when the client advertises MCP Apps UI support, {@link SERVER_MODE.DEFAULT} otherwise.
 */
export function resolveServerMode(option: ServerModeOption, clientSupportsUi: boolean): SERVER_MODE {
    if (option !== 'auto') return option;
    if (!SERVER_MODE_AUTO_DETECTION_ENABLED) return SERVER_MODE.DEFAULT;
    return clientSupportsUi ? SERVER_MODE.APPS : SERVER_MODE.DEFAULT;
}
