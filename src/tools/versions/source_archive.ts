import type { ActorVersionSourceFile, KeyValueStoreClient } from 'apify-client';
import { zipSync } from 'fflate';

import { createHmacSignatureAsync } from '@apify/utilities';

import type { ApifyClient } from '../../apify_client.js';

/** The store `apify push` uploads to, so CLI and MCP pushes of one Actor share it. */
export function formatSourceStoreName(actorId: string): string {
    return `actor-${actorId}-source`;
}

/** The record `apify push` writes for a version, so a later CLI push replaces the same zip. */
export function formatSourceRecordKey(versionNumber: string): string {
    return `version-${versionNumber}.zip`;
}

/** The files as a zip with their paths as entry names, at the compression level `apify push` uses. */
export function buildSourceZip(files: readonly ActorVersionSourceFile[]): Buffer {
    const entries = Object.fromEntries(
        files.map(({ name, format, content }) => [name, Buffer.from(content, format === 'BASE64' ? 'base64' : 'utf8')]),
    );
    return Buffer.from(zipSync(entries, { level: 6 }));
}

/** apify-client sends a Buffer as the record body (`apify push` passes one too); its type only admits JSON. */
type RecordValue = Parameters<KeyValueStoreClient['setRecord']>[0]['value'];

type UploadSourceArchiveParams = { actorId: string; versionNumber: string; zip: Buffer };

/**
 * Uploads the zip to the version's record in the Actor's source store and returns the URL the build
 * worker downloads it from. The URL points at the API this client talks to, which is where the worker
 * fetches from, and carries the store's signature when the store is restricted, because the worker
 * sends no token. The same URL `apify push` builds, minus its `disableRedirect` parameter, which the
 * API no longer reads.
 */
export async function uploadSourceArchive(client: ApifyClient, params: UploadSourceArchiveParams): Promise<string> {
    const { actorId, versionNumber, zip } = params;
    const store = await client.keyValueStores().getOrCreate(formatSourceStoreName(actorId));
    const key = formatSourceRecordKey(versionNumber);
    await client
        .keyValueStore(store.id)
        .setRecord({ key, value: zip as unknown as RecordValue, contentType: 'application/zip' });
    const url = new URL(`${client.baseUrl}/key-value-stores/${store.id}/records/${key}`);
    if (store.urlSigningSecretKey) {
        url.searchParams.set('signature', await createHmacSignatureAsync(store.urlSigningSecretKey, key));
    }
    return url.toString();
}
