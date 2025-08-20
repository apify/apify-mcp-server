/*
 * Actor input processing.
 *
 * Normalizes raw inputs (CLI/env/HTTP) into a consistent `Input` shape.
 * No tool-loading is done here; we only canonicalize values and preserve
 * intent via `undefined` (use defaults later) vs empty (explicitly none).
 */
import log from '@apify/log';

import type { Input, ToolSelector } from './types.js';

/**
 * Normalize user-provided input into a canonical `Input`.
 *
 * Responsibilities:
 * - Coerce `actors`, `tools` from string/array into trimmed arrays ('' → []).
 * - Normalize booleans (including legacy `enableActorAutoLoading`).
 * - Merge `actors` into `tools` so selection lives in one place.
 *
 * Semantics passed to the loader:
 * - `undefined` → use defaults; `[]` → explicitly none.
 */
export function processInput(originalInput: Partial<Input>): Input {
    const input = { ...originalInput } as Input;

    // Helpers
    // Normalize booleans that may arrive as strings or be undefined.
    const toBoolean = (value: unknown, defaultValue: boolean): boolean => {
        if (value === undefined) return defaultValue;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.toLowerCase() === 'true';
        return defaultValue;
    };
    // Normalize lists from comma-separated strings or arrays.
    const normalizeList = (value: string | string[] | undefined): string[] | undefined => {
        if (value === undefined) return undefined;
        if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter((s) => s !== '');
        const trimmed = String(value).trim();
        if (trimmed === '') return [];
        return trimmed.split(',').map((s) => s.trim()).filter((s) => s !== '');
    };

    // Normalize actors (strings and arrays) to a clean array or undefined
    input.actors = normalizeList(input.actors) as unknown as string[] | undefined;

    // Map deprecated flag to the new one and normalize both to boolean.
    if (input.enableAddingActors === undefined && input.enableActorAutoLoading !== undefined) {
        log.warning('enableActorAutoLoading is deprecated, use enableAddingActors instead');
        input.enableAddingActors = toBoolean(input.enableActorAutoLoading, false);
    } else {
        input.enableAddingActors = toBoolean(input.enableAddingActors, false);
    }

    // Normalize tools (strings/arrays) to a clean array or undefined
    input.tools = normalizeList(input.tools as string | string[] | undefined) as unknown as ToolSelector[] | undefined;

    // Merge actors into tools. If tools undefined → tools = actors, then remove actors;
    // otherwise append actors to tools.
    // NOTE (future): Actor names contain '/', unlike internal tool names or categories.
    if (Array.isArray(input.actors) && input.actors.length > 0) {
        if (input.tools === undefined) {
            input.tools = [...input.actors] as ToolSelector[];
            // Treat as if only tools were specified; clear actors to avoid duplicate semantics
            delete (input as Record<string, unknown>).actors;
        } else {
            const currentTools: ToolSelector[] = Array.isArray(input.tools)
                ? input.tools
                : [input.tools as ToolSelector];
            input.tools = [...currentTools, ...input.actors] as ToolSelector[];
        }
    }
    return input;
}
