import type { ActorVersionSourceFile } from 'apify-client';

import { UserInputError } from '../../errors.js';

/** The platform needs this file to build an Actor; `apify push` refuses a directory without it. */
export const ACTOR_CONFIG_PATH = '.actor/actor.json';

/** A POSIX root (`/abs`) or a Windows drive root (`C:\abs`, `C:/abs`). */
const ABSOLUTE_PATH_REGEX = /^(?:[\\/]|[a-zA-Z]:[\\/])/;

/**
 * Strict base64: whole quartets, correct padding, no whitespace. `Buffer.from(content, 'base64')`
 * silently skips invalid characters, so it cannot be the check.
 */
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type SourceFileInput = { path: string; content: string; encoding?: 'utf8' | 'base64' };

/**
 * POSIX path relative to the Actor root: backslashes become `/`; empty and `.` segments (`./`, doubled
 * slashes, a trailing slash) are dropped. `..` segments are kept so the caller can reject them.
 */
export function normalizeSourcePath(path: string): string {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .join('/');
}

/**
 * Throws `UserInputError` on the first problem with the files: an absolute path, a path empty after
 * normalization, a directory, a `..` segment, a duplicate, or base64 content that is not base64.
 */
export function validateSourceFiles(files: readonly SourceFileInput[]): void {
    const seen = new Set<string>();
    for (const { path, content, encoding } of files) {
        if (ABSOLUTE_PATH_REGEX.test(path)) throw new UserInputError(`File path '${path}' must be relative to the Actor root, not absolute.`);
        const normalized = normalizeSourcePath(path);
        if (normalized === '') throw new UserInputError(`File path '${path}' is empty after normalization.`);
        if (/[\\/]$/.test(path)) throw new UserInputError(`File path '${path}' must name a file, not a directory.`);
        if (normalized.split('/').includes('..')) throw new UserInputError(`File path '${path}' must not contain '..' segments.`);
        if (seen.has(normalized)) throw new UserInputError(`File path '${normalized}' is listed more than once.`);
        seen.add(normalized);
        if (encoding === 'base64' && !BASE64_REGEX.test(content)) {
            throw new UserInputError(`File '${path}' has encoding base64 but its content is not valid base64.`);
        }
    }
}

/** Maps the tool's files to the `sourceFiles` shape the API takes: normalized name, TEXT or BASE64. */
export function toSourceFiles(files: readonly SourceFileInput[]): ActorVersionSourceFile[] {
    return files.map(({ path, content, encoding }) => ({
        name: normalizeSourcePath(path),
        format: encoding === 'base64' ? 'BASE64' : 'TEXT',
        content,
    }));
}

/** Decoded size of the files: utf8 byte length for TEXT, decoded length for BASE64 (validated by `validateSourceFiles`). */
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
