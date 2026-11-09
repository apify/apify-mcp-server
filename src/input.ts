/*
 * Actor input processing.
 *
 * Normalizes raw inputs (CLI/env/HTTP) into a consistent `Input` shape.
 * No tool-loading is done here; we only canonicalize values and preserve
 * intent via `undefined` (use defaults later) vs empty (explicitly none).
 */
import type { Input } from './types.js';

// Normalize lists from comma-separated strings or arrays.
export function normalizeList(value: string | unknown[] | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter((s) => s !== '');
    const trimmed = String(value).trim();
    if (trimmed === '') return [];
    return trimmed
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
}

/**
 * Canonicalize `actors` and `tools` into trimmed arrays and merge `actors` into `tools`, so the
 * loader reads one selector list. `undefined` keeps the defaults, `[]` means explicitly none.
 */
export function processInput(originalInput: Partial<Input>): Input {
    const actors = normalizeList(originalInput.actors);
    let tools = normalizeList(originalInput.tools);

    // Actor names contain '/', unlike categories and internal tool names, so the loader can tell them apart.
    if (Array.isArray(actors) && actors.length > 0) {
        tools = tools === undefined ? [...actors] : [...tools, ...actors];
    }

    return {
        ...originalInput,
        actors: Array.isArray(actors) && actors.length > 0 ? undefined : actors,
        tools,
    };
}
