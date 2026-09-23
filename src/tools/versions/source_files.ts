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
 * Extensions whose files are never text. `apify push` classifies by MIME type, which calls `.ts` a
 * video, so an explicit list is used here; an agent can still override it with an explicit `encoding`.
 */
const BINARY_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'avif',
    'bmp',
    'ico',
    'pdf',
    'zip',
    'gz',
    'tgz',
    'tar',
    'bz2',
    'xz',
    '7z',
    'rar',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    'mp3',
    'mp4',
    'm4a',
    'wav',
    'ogg',
    'webm',
    'mov',
    'bin',
    'dat',
    'wasm',
    'exe',
    'dll',
    'so',
    'dylib',
    'jar',
    'class',
    'pyc',
    'sqlite',
    'db',
    'parquet',
    'xlsx',
    'docx',
    'pptx',
]);

export function hasBinaryExtension(path: string): boolean {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return path.includes('.') && BINARY_EXTENSIONS.has(extension);
}

/**
 * The API format of a file: an explicit `encoding` wins; without one, a file with a binary extension
 * is base64 (the caller has no other way to carry its bytes) and everything else is text.
 */
function resolveSourceFormat({ path, encoding }: SourceFileInput): ActorVersionSourceFile['format'] {
    if (encoding !== undefined) return encoding === 'base64' ? 'BASE64' : 'TEXT';
    return hasBinaryExtension(path) ? 'BASE64' : 'TEXT';
}

/**
 * POSIX path relative to the Actor root: backslashes become `/`; empty and `.` segments (`./`, doubled
 * slashes, a trailing slash) are dropped. `..` segments are kept so the caller can reject them.
 */
function normalizeSourcePath(path: string): string {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .join('/');
}

/**
 * Throws `UserInputError` on the first problem with the files: an absolute path, a path empty after
 * normalization, a directory, a `..` segment, a root file named `__proto__`, a duplicate, base64
 * content that is not base64, or a binary file (by extension, with no `encoding` given) whose content
 * is not base64.
 */
export function validateSourceFiles(files: readonly SourceFileInput[]): void {
    const seen = new Set<string>();
    for (const { path, content, encoding } of files) {
        if (ABSOLUTE_PATH_REGEX.test(path))
            throw new UserInputError(`File path '${path}' must be relative to the Actor root, not absolute.`);
        const normalized = normalizeSourcePath(path);
        if (normalized === '') throw new UserInputError(`File path '${path}' is empty after normalization.`);
        if (/[\\/]$/.test(path)) throw new UserInputError(`File path '${path}' must name a file, not a directory.`);
        if (normalized.split('/').includes('..'))
            throw new UserInputError(`File path '${path}' must not contain '..' segments.`);
        // The zip writer keys entries by path on a plain object, where this name sets the prototype instead.
        if (normalized === '__proto__') throw new UserInputError(`File path '${path}' is not allowed.`);
        if (seen.has(normalized)) throw new UserInputError(`File path '${normalized}' is listed more than once.`);
        seen.add(normalized);
        if (encoding === 'base64' && !BASE64_REGEX.test(content)) {
            throw new UserInputError(`File '${path}' has encoding base64 but its content is not valid base64.`);
        }
        if (encoding === undefined && hasBinaryExtension(path) && !BASE64_REGEX.test(content)) {
            throw new UserInputError(
                `File '${path}' is binary by its extension, so its content must be base64; pass encoding 'utf8' if it really is text.`,
            );
        }
    }
}

/** Maps the tool's files to the `sourceFiles` shape the API takes: normalized name, TEXT or BASE64. */
export function toSourceFiles(files: readonly SourceFileInput[]): ActorVersionSourceFile[] {
    return files.map((file) => ({
        name: normalizeSourcePath(file.path),
        format: resolveSourceFormat(file),
        content: file.content,
    }));
}

/**
 * Size of the files as the platform measures it before applying its limit: its byte count of each
 * `content` string as sent, so a BASE64 file counts its encoded text, a third more than the decoded
 * bytes. Counting the same way keeps the inline-or-zip decision on the platform's side of the boundary.
 */
export function getSourceFilesSizeBytes(sourceFiles: readonly ActorVersionSourceFile[]): number {
    return sourceFiles.reduce((total, { content }) => total + getPlatformStringByteLength(content), 0);
}

/**
 * The platform's `stringByteLength`: the utf8 length, except that a surrogate pair counts 5 bytes rather
 * than 4 (each half is counted as a 3-byte code unit, then the trail half gives one back).
 */
function getPlatformStringByteLength(text: string): number {
    let { length } = text;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code > 0x7f && code <= 0x7ff) length += 1;
        if (code > 0x7ff && code <= 0xffff) length += 2;
        if (code >= 0xdc00 && code <= 0xdfff) length -= 1;
    }
    return length;
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
