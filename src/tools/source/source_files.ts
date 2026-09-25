import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { ActorVersionSourceFile } from 'apify-client';

/**
 * Extensions whose files are never text. `apify push` classifies by MIME type, which calls `.ts` a
 * video, so an explicit list is used here.
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

/** Hashes and revisions are this many hex characters of a SHA-256, so an agent can compare them by eye. */
const HASH_HEX_LENGTH = 16;

// `ignoreBOM` keeps a byte order mark in the text, so the text encodes back to the same bytes and hash.
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type SourceFileFormat = ActorVersionSourceFile['format'];

/** One regular file of a version, the same shape whether the version stores its files inline or in a zip. */
export type SourceFile = {
    path: string;
    /** The stored format for an inline file; for a zip entry, which stores none, the detected one. */
    format: SourceFileFormat;
    /** How the content is returned: UTF-8 text as utf8 whatever its stored format, anything else as base64. */
    encoding: 'utf8' | 'base64';
    /** Length of the decoded bytes. */
    sizeBytes: number;
    hash: string;
    /** UTF-8 length of the content as returned: the text itself, or its base64. */
    contentBytes: number;
    /** Built on demand, so content that is not returned is never decoded or encoded to base64. */
    readContent: () => string;
};

export function hasBinaryExtension(path: string): boolean {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return path.includes('.') && BINARY_EXTENSIONS.has(extension);
}

/**
 * A path relative to the Actor root, the way the build worker writes it: backslashes become `/`, and empty and `.`
 * segments are dropped. `..` segments are kept; the zip reader refuses them.
 */
export function parseSourcePath(name: string): string {
    return name
        .split(/[\\/]/)
        .filter((segment) => segment !== '' && segment !== '.')
        .join('/');
}

function getSha256Prefix(data: Uint8Array | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, HASH_HEX_LENGTH);
}

/** The same value as `sha256sum <file> | cut -c1-16` on the file's bytes. */
export function getSourceFileHash(bytes: Uint8Array): string {
    return getSha256Prefix(bytes);
}

/**
 * Orders paths by their UTF-8 bytes, the order `LC_ALL=C sort` gives, so the manifest and the revision do not
 * depend on the locale or on how JavaScript compares UTF-16 strings.
 */
export function compareSourcePaths(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Identifies the file set: one `path\0hash\n` line per regular file, sorted by path. Neither the storage (inline or
 * zip) nor the stored format goes in, so the same files give the same revision however they are stored.
 */
export function buildFilesRevision(files: readonly Pick<SourceFile, 'path' | 'hash'>[]): string {
    const lines = [...files]
        .sort((a, b) => compareSourcePaths(a.path, b.path))
        .map(({ path, hash }) => `${path}\0${hash}\n`);
    return getSha256Prefix(lines.join(''));
}

/** Identifies a version whose source lives at a URL: the URL is all the platform holds for it. */
export function buildUrlRevision(sourceType: string, url: string): string {
    return getSha256Prefix(`${sourceType}\0${url}`);
}

/** Base64 text takes 4 characters per 3 bytes, the last group padded. */
function getBase64Length(byteLength: number): number {
    return Math.ceil(byteLength / 3) * 4;
}

/**
 * Text when the extension is not a binary one and the bytes are valid UTF-8, base64 otherwise, so no byte is lost.
 * `isUtf8` checks without building a string; the text is decoded only when it is returned, so a listing holds only
 * the bytes.
 */
function buildSourceFileFromBytes(path: string, bytes: Uint8Array, storedBase64?: string): SourceFile {
    const common = { path, sizeBytes: bytes.length, hash: getSourceFileHash(bytes) };
    // An inline file keeps its stored format; a zip entry, which stores none, reports TEXT for text.
    const format: SourceFileFormat = storedBase64 === undefined ? 'TEXT' : 'BASE64';
    if (!hasBinaryExtension(path) && isUtf8(bytes)) {
        // Valid UTF-8 decoded with the BOM kept encodes back to the same bytes, so its length is the byte count.
        const readContent = () => UTF8_DECODER.decode(bytes);
        return { ...common, format, encoding: 'utf8', contentBytes: bytes.length, readContent };
    }
    return {
        ...common,
        format: 'BASE64',
        encoding: 'base64',
        contentBytes: storedBase64 === undefined ? getBase64Length(bytes.length) : Buffer.byteLength(storedBase64),
        readContent: () => storedBase64 ?? Buffer.from(bytes).toString('base64'),
    };
}

/**
 * A file stored inline in the version; its format is the one the platform stored. The platform stores a file without
 * `format` or `content` as given, and the build worker reads them as TEXT and as empty, so the same defaults apply.
 * A UTF-8 file stored as BASE64 (`apify push` picks the format by MIME type) is returned as text, the same as from a
 * zip.
 */
export function buildInlineSourceFile(file: ActorVersionSourceFile): SourceFile {
    const { name, format }: Partial<ActorVersionSourceFile> & { name: string } = file;
    const content = (file as Partial<ActorVersionSourceFile>).content ?? '';
    // A name that normalizes to nothing, such as `.`, is kept as stored rather than dropped.
    const path = parseSourcePath(name) || name;
    if (format === 'BASE64') return buildSourceFileFromBytes(path, Buffer.from(content, 'base64'), content);
    const bytes = Buffer.from(content, 'utf8');
    return {
        path,
        format: 'TEXT',
        encoding: 'utf8',
        sizeBytes: bytes.length,
        hash: getSourceFileHash(bytes),
        contentBytes: bytes.length,
        readContent: () => content,
    };
}

/** A file read from a zip, which carries no format: TEXT or BASE64 as detected. */
export function buildArchiveSourceFile(path: string, bytes: Uint8Array): SourceFile {
    return buildSourceFileFromBytes(path, bytes);
}
