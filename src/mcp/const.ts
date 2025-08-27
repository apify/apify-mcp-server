export const MAX_TOOL_NAME_LENGTH = 64;
export const SERVER_ID_LENGTH = 8;
export const EXTERNAL_TOOL_CALL_TIMEOUT_MSEC = 120_000; // 2 minutes

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
