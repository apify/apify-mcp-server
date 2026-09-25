import { inflateRawSync } from 'node:zlib';

import { UserInputError } from '../../errors.js';
import { BYTES_PER_MIB, MAX_SOURCE_PATH_LENGTH, parseSourcePath } from './source_files.js';

export const MAX_ARCHIVE_ENTRIES = 10_000;

/** The declared uncompressed size of all entries together; every entry is inflated to hash it. */
export const MAX_ARCHIVE_INFLATED_BYTES = 64 * BYTES_PER_MIB;

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const MAX_ARCHIVE_COMMENT_LENGTH = 0xffff;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_LENGTH = 20;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_DIRECTORY_HEADER_LENGTH = 46;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_LENGTH = 30;

/** Zip64 archives put this in a 16-bit or 32-bit field and the real value in a zip64 record. */
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

/** General purpose flag bits: traditional encryption, strong encryption, and an encrypted central directory. */
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;

const COMPRESSION_METHOD_STORED = 0;
const COMPRESSION_METHOD_DEFLATED = 8;

/** Hosts in the "version made by" field whose external attributes carry a Unix mode in the upper 16 bits. */
const UNIX_MODE_HOSTS: ReadonlySet<number> = new Set([3, 19]);
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_FILE_TYPE_REGULAR = 0o100000;
const UNIX_FILE_TYPE_DIRECTORY = 0o040000;
const UNIX_FILE_TYPE_SYMLINK = 0o120000;

/** A POSIX root (`/abs`), a backslash root, or a Windows drive (`C:\abs`, `C:abs`). */
export const ABSOLUTE_NAME_REGEX = /^(?:[\\/]|[a-zA-Z]:)/;

const UTF8_NAME_DECODER = new TextDecoder('utf-8', { fatal: true });

type CentralDirectoryEntry = {
    name: string;
    /** Compared with the local header's name, so the two cannot list different files. */
    nameBytes: Buffer;
    path: string;
    isDirectory: boolean;
    method: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
};

type CentralDirectoryLocation = { entryCount: number; offset: number; size: number; endOffset: number };

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let value = i;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[i] = value >>> 0;
    }
    return table;
}

/**
 * CRC-32 as zip uses it (IEEE 802.3, reflected). Implemented here because node's `zlib.crc32` needs Node 22.2 and
 * the package supports Node 22.0.
 */
export function getCrc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function buildRefusal(reason: string): UserInputError {
    return new UserInputError(`The version's zip was refused: ${reason}.`);
}

/**
 * The end of central directory record is the last thing in a zip, followed only by a comment of the length it
 * declares; the record whose comment ends exactly at the end of the data is the real one.
 */
function findCentralDirectory(zip: Buffer): CentralDirectoryLocation {
    const lowestOffset = Math.max(0, zip.length - END_OF_CENTRAL_DIRECTORY_LENGTH - MAX_ARCHIVE_COMMENT_LENGTH);
    for (let offset = zip.length - END_OF_CENTRAL_DIRECTORY_LENGTH; offset >= lowestOffset; offset--) {
        if (zip.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
        if (offset + END_OF_CENTRAL_DIRECTORY_LENGTH + zip.readUInt16LE(offset + 20) !== zip.length) continue;
        return readCentralDirectoryLocation(zip, offset);
    }
    throw buildRefusal('it is not a zip archive');
}

function readCentralDirectoryLocation(zip: Buffer, endOffset: number): CentralDirectoryLocation {
    const diskNumber = zip.readUInt16LE(endOffset + 4);
    const centralDirectoryDisk = zip.readUInt16LE(endOffset + 6);
    const diskEntryCount = zip.readUInt16LE(endOffset + 8);
    const entryCount = zip.readUInt16LE(endOffset + 10);
    const size = zip.readUInt32LE(endOffset + 12);
    const offset = zip.readUInt32LE(endOffset + 16);
    const locatorOffset = endOffset - ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_LENGTH;
    const hasZip64Locator =
        locatorOffset >= 0 && zip.readUInt32LE(locatorOffset) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE;
    if (hasZip64Locator || entryCount === ZIP64_MARKER_16 || size === ZIP64_MARKER_32 || offset === ZIP64_MARKER_32) {
        throw buildRefusal('it is a zip64 archive');
    }
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
        throw buildRefusal('it is split across several files');
    }
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw buildRefusal(`it has ${entryCount} entries, over the ${MAX_ARCHIVE_ENTRIES} this tool reads`);
    }
    if (offset + size > endOffset) throw buildRefusal('its central directory points outside the archive');
    return { entryCount, offset, size, endOffset };
}

function hasZip64ExtraField(extra: Buffer): boolean {
    let offset = 0;
    while (offset + 4 <= extra.length) {
        if (extra.readUInt16LE(offset) === ZIP64_EXTRA_FIELD_ID) return true;
        offset += 4 + extra.readUInt16LE(offset + 2);
    }
    return false;
}

function decodeEntryName(nameBytes: Buffer): string {
    try {
        return UTF8_NAME_DECODER.decode(nameBytes);
    } catch {
        // Zip allows CP437 names without the UTF-8 flag; nothing that pushes Actor source writes them.
        throw buildRefusal('an entry name is not valid UTF-8');
    }
}

/**
 * The path relative to the Actor root, empty for a root folder entry such as `./`. Throws for a name that could escape
 * the root or cannot be a path. Runs before any other check, so no refusal repeats a NUL or an overlong name.
 */
function parseEntryPath(name: string): string {
    if (name.includes('\0')) throw buildRefusal(`an entry name contains a NUL character`);
    if (name.length > MAX_SOURCE_PATH_LENGTH) {
        throw buildRefusal(`entry ${name.slice(0, 40)}... has a name over ${MAX_SOURCE_PATH_LENGTH} characters`);
    }
    if (ABSOLUTE_NAME_REGEX.test(name)) throw buildRefusal(`entry ${name} has an absolute path`);
    const path = parseSourcePath(name);
    if (path.split('/').includes('..')) throw buildRefusal(`entry ${name} has a '..' segment`);
    return path;
}

/** The Unix file type from the external attributes, or undefined when the archive was not written on Unix. */
function getUnixFileType(versionMadeBy: number, externalAttributes: number): number | undefined {
    if (!UNIX_MODE_HOSTS.has(versionMadeBy >>> 8)) return undefined;
    return (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
}

function readCentralDirectoryEntry(zip: Buffer, offset: number, location: CentralDirectoryLocation) {
    const centralDirectoryEnd = location.offset + location.size;
    if (
        offset + CENTRAL_DIRECTORY_HEADER_LENGTH > centralDirectoryEnd ||
        zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE
    ) {
        throw buildRefusal('its central directory is corrupt');
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const nextOffset = offset + CENTRAL_DIRECTORY_HEADER_LENGTH + nameLength + extraLength + commentLength;
    if (nextOffset > centralDirectoryEnd) throw buildRefusal('its central directory is corrupt');
    const nameStart = offset + CENTRAL_DIRECTORY_HEADER_LENGTH;
    const nameBytes = zip.subarray(nameStart, nameStart + nameLength);
    const name = decodeEntryName(nameBytes);
    const path = parseEntryPath(name);
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const diskNumber = zip.readUInt16LE(offset + 34);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const extra = zip.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    if (
        hasZip64ExtraField(extra) ||
        compressedSize === ZIP64_MARKER_32 ||
        uncompressedSize === ZIP64_MARKER_32 ||
        localHeaderOffset === ZIP64_MARKER_32 ||
        diskNumber === ZIP64_MARKER_16
    ) {
        throw buildRefusal(`entry ${name} uses zip64`);
    }
    if (flags & ENCRYPTION_FLAGS) throw buildRefusal(`entry ${name} is encrypted`);
    if (method !== COMPRESSION_METHOD_STORED && method !== COMPRESSION_METHOD_DEFLATED) {
        throw buildRefusal(
            `entry ${name} uses compression method ${method}; only stored and deflated entries are read`,
        );
    }
    const fileType = getUnixFileType(zip.readUInt16LE(offset + 4), zip.readUInt32LE(offset + 38));
    if (fileType === UNIX_FILE_TYPE_SYMLINK) throw buildRefusal(`entry ${name} is a symbolic link`);
    if (fileType && fileType !== UNIX_FILE_TYPE_REGULAR && fileType !== UNIX_FILE_TYPE_DIRECTORY) {
        throw buildRefusal(`entry ${name} is not a regular file or a folder`);
    }
    if (method === COMPRESSION_METHOD_STORED && compressedSize !== uncompressedSize) {
        throw buildRefusal(`entry ${name} is stored uncompressed but declares two different sizes`);
    }
    const isDirectory = /[\\/]$/.test(name) || fileType === UNIX_FILE_TYPE_DIRECTORY;
    if (path === '' && !isDirectory) throw buildRefusal(`entry ${name} has an empty path`);
    const entry: CentralDirectoryEntry = {
        name,
        nameBytes,
        path,
        isDirectory,
        method,
        // Read from the central directory, never the local header: `apify push` sets the data descriptor flag, so
        // its local headers carry zeros for the CRC and the sizes.
        crc32: zip.readUInt32LE(offset + 16),
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
    };
    return { entry, nextOffset };
}

function readCentralDirectory(zip: Buffer, location: CentralDirectoryLocation): CentralDirectoryEntry[] {
    const entries: CentralDirectoryEntry[] = [];
    const seenPaths = new Set<string>();
    let inflatedBytes = 0;
    let { offset } = location;
    for (let i = 0; i < location.entryCount; i++) {
        const { entry, nextOffset } = readCentralDirectoryEntry(zip, offset, location);
        offset = nextOffset;
        // A root folder entry such as `./` holds nothing; unzip extracts such an archive without complaint.
        if (entry.path === '') continue;
        if (seenPaths.has(entry.path)) throw buildRefusal(`the path ${entry.path} appears more than once`);
        seenPaths.add(entry.path);
        inflatedBytes += entry.uncompressedSize;
        if (inflatedBytes > MAX_ARCHIVE_INFLATED_BYTES) {
            throw buildRefusal(
                `its entries declare more than ${MAX_ARCHIVE_INFLATED_BYTES / BYTES_PER_MIB} MiB uncompressed`,
            );
        }
        entries.push(entry);
    }
    // An end record that declares fewer entries than the central directory holds would hide files that another zip
    // reader extracts.
    if (offset !== location.offset + location.size) {
        throw buildRefusal('its central directory does not match its end record');
    }
    return entries;
}

/**
 * The entry's compressed bytes. The local header's sizes may be zeros, so it is read only for where the data starts
 * (its own name and extra lengths, which can differ from the central ones) and checked to name the same file with the
 * same method, so a reader that streams local headers sees the same files.
 */
function extractCompressedData(zip: Buffer, entry: CentralDirectoryEntry, centralDirectoryOffset: number): Buffer {
    const headerOffset = entry.localHeaderOffset;
    if (
        headerOffset + LOCAL_FILE_HEADER_LENGTH > centralDirectoryOffset ||
        zip.readUInt32LE(headerOffset) !== LOCAL_FILE_HEADER_SIGNATURE
    ) {
        throw buildRefusal(`entry ${entry.name} points outside the archive`);
    }
    const nameStart = headerOffset + LOCAL_FILE_HEADER_LENGTH;
    const nameEnd = nameStart + zip.readUInt16LE(headerOffset + 26);
    const dataStart = nameEnd + zip.readUInt16LE(headerOffset + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > centralDirectoryOffset) throw buildRefusal(`entry ${entry.name} points outside the archive`);
    if (
        !zip.subarray(nameStart, nameEnd).equals(entry.nameBytes) ||
        zip.readUInt16LE(headerOffset + 8) !== entry.method
    ) {
        throw buildRefusal(`entry ${entry.name} has a local header that does not match the central directory`);
    }
    return zip.subarray(dataStart, dataEnd);
}

/**
 * Inflates into at most the declared size (zlib throws past `maxOutputLength`), so an entry that lies about its size
 * cannot take more memory than the declared total allows.
 */
function inflateEntry(zip: Buffer, entry: CentralDirectoryEntry, centralDirectoryOffset: number): Uint8Array {
    const compressed = extractCompressedData(zip, entry, centralDirectoryOffset);
    let bytes: Uint8Array;
    try {
        bytes =
            entry.method === COMPRESSION_METHOD_STORED
                ? compressed
                : inflateRawSync(compressed, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
    } catch {
        throw buildRefusal(`entry ${entry.name} is corrupt or larger than it declares`);
    }
    if (bytes.length !== entry.uncompressedSize) {
        throw buildRefusal(`entry ${entry.name} is not the size it declares`);
    }
    if (getCrc32(bytes) !== entry.crc32) throw buildRefusal(`entry ${entry.name} fails its CRC-32 check`);
    return bytes;
}

/**
 * Reads the regular files of a zip, keyed by their path relative to the Actor root; folder entries are left out.
 * Everything is taken from the central directory and checked before any entry is inflated, and each entry's length
 * and CRC-32 are checked after, so a truncated or tampered zip is refused instead of returning partial content.
 * Throws `UserInputError` for any archive it refuses.
 *
 * A `Map` rather than an object, so an entry named `__proto__` is just a file.
 */
export function readSourceArchive(zip: Uint8Array): Map<string, Uint8Array> {
    const buffer = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
    if (buffer.length < END_OF_CENTRAL_DIRECTORY_LENGTH) throw buildRefusal('it is not a zip archive');
    const location = findCentralDirectory(buffer);
    const files = new Map<string, Uint8Array>();
    for (const entry of readCentralDirectory(buffer, location)) {
        if (entry.isDirectory) continue;
        files.set(entry.path, inflateEntry(buffer, entry, location.offset));
    }
    return files;
}
