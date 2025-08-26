/*
 * Actor input processing.
 *
 * Normalizes raw inputs (CLI/env/HTTP) into a consistent `Input` shape.
 * No tool-loading is done here; we only canonicalize values and preserve
 * intent via `undefined` (use defaults later) vs empty (explicitly none).
 */
import log from '@apify/log';

import type { Input, ToolSelector } from './types.js';

// Helpers
// Normalize booleans that may arrive as strings or be undefined.
export function toBoolean(value: unknown, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return defaultValue;
}

// Normalize lists from comma-separated strings or arrays.
export function normalizeList(value: string | unknown[] | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter((s) => s !== '');
    const trimmed = String(value).trim();
    if (trimmed === '') return [];
    return trimmed.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

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
    // Normalize actors (strings and arrays) to a clean array or undefined
    const actors = normalizeList(originalInput.actors) as unknown as string[] | undefined;

    // Map deprecated flag to the new one and normalize both to boolean.
    let enableAddingActors: boolean;
    if (originalInput.enableAddingActors === undefined && originalInput.enableActorAutoLoading !== undefined) {
        log.warning('enableActorAutoLoading is deprecated, use enableAddingActors instead');
        enableAddingActors = toBoolean(originalInput.enableActorAutoLoading, false);
    } else {
        enableAddingActors = toBoolean(originalInput.enableAddingActors, false);
    }

    // Normalize tools (strings/arrays) to a clean array or undefined
    let tools = normalizeList(originalInput.tools as string | string[] | undefined) as unknown as ToolSelector[] | undefined;

    // Merge actors into tools. If tools undefined → tools = actors, then remove actors;
    // otherwise append actors to tools.
    // NOTE (future): Actor names contain '/', unlike internal tool names or categories. We could use that to differentiate between the two.
    if (Array.isArray(actors) && actors.length > 0) {
        if (tools === undefined) {
            tools = [...actors] as ToolSelector[];
        } else {
            const currentTools: ToolSelector[] = Array.isArray(tools)
                ? tools
                : [tools as ToolSelector];
            tools = [...currentTools, ...actors] as ToolSelector[];
        }
    }

    // Return a new object with all properties explicitly defined
    return {
        ...originalInput,
        actors: Array.isArray(actors) && actors.length > 0 && tools !== undefined ? undefined : actors,
        enableAddingActors,
        tools,
    };
}
