import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

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

/** One regular file of a version. */
export type SourceFile = {
    path: string;
    /** How the content is returned: UTF-8 text as utf8 whatever its stored format, anything else as base64. */
    encoding: 'utf8' | 'base64';
    /** Length of the decoded bytes. */
    sizeBytes: number;
    hash: string;
    /** UTF-8 length of the content as returned: the text itself, or its base64. */
    contentBytes: number;
    /** Built on demand, so content that is not returned is never decoded. */
    readContent: () => string;
};

export function hasBinaryExtension(path: string): boolean {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return path.includes('.') && BINARY_EXTENSIONS.has(extension);
}

/** The first 16 hex characters of the SHA-256; for a file's bytes, the same as `sha256sum <file> | cut -c1-16`. */
function getSha256Prefix(data: Uint8Array | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, HASH_HEX_LENGTH);
}

/** Paths in JavaScript's default string order, so the manifest and the revision do not depend on the locale. */
export function compareSourcePaths(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * Identifies the file set: one `path\0hash\n` line per regular file, sorted by path. The stored format does not go
 * in, so a file stored as TEXT or as BASE64 gives the same revision.
 */
export function buildFilesRevision(files: readonly Pick<SourceFile, 'path' | 'hash'>[]): string {
    const lines = [...files]
        .sort((a, b) => compareSourcePaths(a.path, b.path))
        .map(({ path, hash }) => `${path}\0${hash}\n`);
    return getSha256Prefix(lines.join(''));
}

/**
 * A file stored inline in the version. The platform stores a file without `format` or `content` as given, and the build
 * worker reads them as TEXT and as empty, so the same defaults apply. The name is normalized the way the build worker
 * normalizes it before writing the file. A BASE64 file is returned as text when the extension is not a binary one and
 * the bytes are valid UTF-8 (`apify push` picks the format by MIME type), and as its stored base64 otherwise, so no
 * byte is lost. `isUtf8` checks without building a string, so a listing holds only the bytes.
 */
export function buildInlineSourceFile(file: ActorVersionSourceFile): SourceFile {
    const { name, format, content: storedContent }: Partial<ActorVersionSourceFile> & { name: string } = file;
    const content = storedContent ?? '';
    const path = posix.normalize(name);
    const bytes = Buffer.from(content, format === 'BASE64' ? 'base64' : 'utf8');
    const common = { path, sizeBytes: bytes.length, hash: getSha256Prefix(bytes) };
    if (format !== 'BASE64') {
        return { ...common, encoding: 'utf8', contentBytes: bytes.length, readContent: () => content };
    }
    if (!hasBinaryExtension(path) && isUtf8(bytes)) {
        // Valid UTF-8 decoded with the BOM kept encodes back to the same bytes, so its length is the byte count.
        const readContent = () => UTF8_DECODER.decode(bytes);
        return { ...common, encoding: 'utf8', contentBytes: bytes.length, readContent };
    }
    return { ...common, encoding: 'base64', contentBytes: Buffer.byteLength(content), readContent: () => content };
}

/** Console keeps an empty folder as a `{ name, folder: true }` entry with no content; apify-client's type leaves it out. */
export function isFolderEntry(file: ActorVersionSourceFile): boolean {
    return (file as { folder?: boolean }).folder === true;
}

/**
 * The version's regular files, one per path (the last stored entry wins), sorted by path, so the manifest reads the
 * same whatever order the version stores its files in; folder entries are left out.
 */
export function buildFilesManifest(entries: readonly ActorVersionSourceFile[]): SourceFile[] {
    const filesByPath = new Map<string, SourceFile>();
    for (const entry of entries) {
        if (isFolderEntry(entry)) continue;
        const file = buildInlineSourceFile(entry);
        filesByPath.set(file.path, file);
    }
    return [...filesByPath.values()].sort((a, b) => compareSourcePaths(a.path, b.path));
}
