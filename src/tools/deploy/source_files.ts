import type { ActorVersionSourceFile } from 'apify-client';

/** Same cutoff as apify push's MAX_MULTIFILE_BYTES; larger projects need the Apify CLI. */
export const MULTIFILE_SOURCE_MAX_BYTES = 3 * 1024 * 1024;

/** The platform needs this file to build an Actor; `apify push` refuses a directory without it. */
export const ACTOR_CONFIG_PATH = '.actor/actor.json';

export type SourceFileInput = { path: string; content: string; encoding?: 'utf8' | 'base64' };

/**
 * POSIX path relative to the Actor root: backslashes become `/`; empty and `.` segments (leading `/`,
 * `./`, doubled slashes, a trailing slash) are dropped. `..` segments are kept so the caller can reject them.
 */
export function normalizeSourcePath(path: string): string {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .join('/');
}

/** The first problem with the paths (empty after normalization, a directory, a `..` segment, a duplicate), or undefined. */
export function validateSourcePaths(paths: readonly string[]): string | undefined {
    const seen = new Set<string>();
    for (const path of paths) {
        const normalized = normalizeSourcePath(path);
        if (normalized === '') return `File path '${path}' is empty after normalization.`;
        if (/[\\/]$/.test(path)) return `File path '${path}' must name a file, not a directory.`;
        if (normalized.split('/').includes('..')) return `File path '${path}' must not contain '..' segments.`;
        if (seen.has(normalized)) return `File path '${normalized}' is listed more than once.`;
        seen.add(normalized);
    }
    return undefined;
}

/** Maps the tool's files to the `sourceFiles` shape the API takes: normalized name, TEXT or BASE64. */
export function toSourceFiles(files: readonly SourceFileInput[]): ActorVersionSourceFile[] {
    return files.map(({ path, content, encoding }) => ({
        name: normalizeSourcePath(path),
        format: encoding === 'base64' ? 'BASE64' : 'TEXT',
        content,
    }));
}

/** Decoded size of the files: utf8 byte length for TEXT, decoded length for BASE64. */
export function getSourceFilesSizeBytes(sourceFiles: readonly ActorVersionSourceFile[]): number {
    return sourceFiles.reduce(
        (total, { format, content }) =>
            total + (format === 'BASE64' ? Buffer.from(content, 'base64').length : Buffer.byteLength(content, 'utf8')),
        0,
    );
}

/** Existing files not named in `incoming`, then `incoming`; a same-name file is replaced by the incoming one. */
export function mergeSourceFiles(
    existing: readonly ActorVersionSourceFile[],
    incoming: readonly ActorVersionSourceFile[],
): ActorVersionSourceFile[] {
    const incomingNames = new Set(incoming.map((file) => file.name));
    return [...existing.filter((file) => !incomingNames.has(file.name)), ...incoming];
}

export function hasActorConfig(sourceFiles: readonly ActorVersionSourceFile[]): boolean {
    return sourceFiles.some((file) => file.name === ACTOR_CONFIG_PATH);
}
