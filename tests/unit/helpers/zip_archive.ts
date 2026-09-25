import { deflateRawSync } from 'node:zlib';

import { getCrc32 } from '../../../src/tools/source/source_archive.js';

/** One entry of a test zip. Every field after `data` exists to build a broken or malicious archive. */
export type ZipEntryOptions = {
    name: string;
    data?: Uint8Array | string;
    /** 0 stores the bytes, 8 deflates them; any other number is written as is and the bytes are stored. */
    method?: number;
    /** Extra general purpose flag bits, for example 0x0001 for an encrypted entry. */
    flags?: number;
    /**
     * The way `apify push` writes deflated entries: flag bit 3 set, zeros for the CRC and the sizes in the local
     * header, and the real values in a data descriptor after the data.
     */
    hasDataDescriptor?: boolean;
    /** Overrides of what the central directory declares, to make an entry lie. */
    crc32?: number;
    compressedSize?: number;
    uncompressedSize?: number;
    /** Upper byte is the host; 3 is Unix, whose external attributes carry the file mode. */
    versionMadeBy?: number;
    externalAttributes?: number;
    /** Central directory extra field, for example a zip64 record. */
    extraField?: Buffer;
};

export type ZipArchiveOptions = {
    /** Writes a zip64 end of central directory locator before the end record. */
    hasZip64Locator?: boolean;
};

const UNIX_HOST_VERSION_MADE_BY = (3 << 8) | 20;
const REGULAR_FILE_ATTRIBUTES = 0o100644 << 16;
const DIRECTORY_ATTRIBUTES = ((0o040755 << 16) | 0x10) >>> 0;
const UTF8_NAME_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
/** 1980-01-01, the earliest date a zip can hold. */
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1;

function toBytes(data: Uint8Array | string | undefined): Buffer {
    if (data === undefined) return Buffer.alloc(0);
    return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

/** The 16-bit and 32-bit little-endian fields of a zip record, in order. */
function buildRecord(fields: [value: number, byteLength: 2 | 4][]): Buffer {
    const record = Buffer.alloc(fields.reduce((total, [, byteLength]) => total + byteLength, 0));
    let offset = 0;
    for (const [value, byteLength] of fields) {
        if (byteLength === 2) record.writeUInt16LE(value, offset);
        else record.writeUInt32LE(value >>> 0, offset);
        offset += byteLength;
    }
    return record;
}

/** Builds a zip in memory, honest by default; the entry options make it lie in one specific way each. */
export function buildZipArchive(entries: readonly ZipEntryOptions[], options: ZipArchiveOptions = {}): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = toBytes(entry.data);
        const method = entry.method ?? 8;
        const compressed = method === 8 ? deflateRawSync(data) : data;
        const crc32 = getCrc32(data);
        const hasDataDescriptor = entry.hasDataDescriptor === true;
        const flags = UTF8_NAME_FLAG | (hasDataDescriptor ? DATA_DESCRIPTOR_FLAG : 0) | (entry.flags ?? 0);
        const localHeader = buildRecord([
            [0x04034b50, 4],
            [20, 2],
            [flags, 2],
            [method, 2],
            [0, 2],
            [DOS_DATE_1980, 2],
            [hasDataDescriptor ? 0 : crc32, 4],
            [hasDataDescriptor ? 0 : compressed.length, 4],
            [hasDataDescriptor ? 0 : data.length, 4],
            [name.length, 2],
            [0, 2],
        ]);
        const dataDescriptor = hasDataDescriptor
            ? buildRecord([
                  [0x08074b50, 4],
                  [crc32, 4],
                  [compressed.length, 4],
                  [data.length, 4],
              ])
            : Buffer.alloc(0);
        const extraField = entry.extraField ?? Buffer.alloc(0);
        const isDirectory = entry.name.endsWith('/');
        const centralHeader = buildRecord([
            [0x02014b50, 4],
            [entry.versionMadeBy ?? UNIX_HOST_VERSION_MADE_BY, 2],
            [20, 2],
            [flags, 2],
            [method, 2],
            [0, 2],
            [DOS_DATE_1980, 2],
            [entry.crc32 ?? crc32, 4],
            [entry.compressedSize ?? compressed.length, 4],
            [entry.uncompressedSize ?? data.length, 4],
            [name.length, 2],
            [extraField.length, 2],
            [0, 2],
            [0, 2],
            [0, 2],
            [entry.externalAttributes ?? (isDirectory ? DIRECTORY_ATTRIBUTES : REGULAR_FILE_ATTRIBUTES), 4],
            [offset, 4],
        ]);
        localParts.push(localHeader, name, compressed, dataDescriptor);
        centralParts.push(centralHeader, name, extraField);
        offset += localHeader.length + name.length + compressed.length + dataDescriptor.length;
    }
    const centralDirectory = Buffer.concat(centralParts);
    const zip64Locator = options.hasZip64Locator
        ? buildRecord([
              [0x07064b50, 4],
              [0, 4],
              [0, 4],
              [0, 4],
              [1, 4],
          ])
        : Buffer.alloc(0);
    const endOfCentralDirectory = buildRecord([
        [0x06054b50, 4],
        [0, 2],
        [0, 2],
        [entries.length, 2],
        [entries.length, 2],
        [centralDirectory.length, 4],
        [offset, 4],
        [0, 2],
    ]);
    return Buffer.concat([...localParts, centralDirectory, zip64Locator, endOfCentralDirectory]);
}
