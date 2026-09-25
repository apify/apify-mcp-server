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
    format: SourceFileFormat;
    /** Length of the decoded bytes. */
    sizeBytes: number;
    hash: string;
    /** UTF-8 length of the content as returned: the text itself, or its base64. */
    contentBytes: number;
    /** Built on demand, so a zip's binaries that are not returned are never encoded to base64. */
    readContent: () => string;
};

export function hasBinaryExtension(path: string): boolean {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return path.includes('.') && BINARY_EXTENSIONS.has(extension);
}

/** The text, or undefined when the bytes are not valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
    try {
        return UTF8_DECODER.decode(bytes);
    } catch {
        // The decoder is fatal: bytes that are not UTF-8 throw instead of turning into replacement characters.
        return undefined;
    }
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

/** A file stored inline in the version; its format is the one the platform stored. */
export function buildInlineSourceFile({ name, format, content }: ActorVersionSourceFile): SourceFile {
    const bytes = Buffer.from(content, format === 'BASE64' ? 'base64' : 'utf8');
    return {
        path: name,
        format,
        sizeBytes: bytes.length,
        hash: getSourceFileHash(bytes),
        contentBytes: Buffer.byteLength(content, 'utf8'),
        readContent: () => content,
    };
}

/**
 * A file read from a zip, which carries no format: text when the extension is not a binary one and the bytes are
 * valid UTF-8, base64 otherwise, so no byte is lost.
 */
export function buildArchiveSourceFile(path: string, bytes: Uint8Array): SourceFile {
    const common = { path, sizeBytes: bytes.length, hash: getSourceFileHash(bytes) };
    const text = hasBinaryExtension(path) ? undefined : decodeUtf8(bytes);
    if (text !== undefined) {
        // Valid UTF-8 decoded with the BOM kept encodes back to the same bytes, so its length is the byte count.
        return { ...common, format: 'TEXT', contentBytes: bytes.length, readContent: () => text };
    }
    return {
        ...common,
        format: 'BASE64',
        contentBytes: getBase64Length(bytes.length),
        readContent: () => Buffer.from(bytes).toString('base64'),
    };
}
