import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import { ActorInputValidationError } from '../errors.js';
import { logHttpError } from './logging.js';

/** Bounds the extra round trip so a slow validate-input call never dominates call-actor's latency budget. */
const VALIDATE_INPUT_TIMEOUT_MSEC = 5_000;

const DEFAULT_INVALID_INPUT_MESSAGE = 'Input does not match the Actor input schema.';

type ValidateInputErrorBody = { error?: { message?: string } };

/**
 * Validates input against the Actor's real schema via Apify's `validate-input` endpoint — the
 * server's own AJV gate validates a derived/shortened copy that can miss real errors (#736, #1253).
 *
 * Fails open on anything but a clean 400: an unavailable best-effort check must never block a run
 * that would otherwise have started; the Actor's own run-time validation is the real backstop.
 *
 * @throws {ActorInputValidationError} only on a confirmed-invalid verdict from the platform.
 */
export async function validateActorInputRemotely(params: {
    apifyClient: ApifyClient;
    actorId: string;
    input: Record<string, unknown>;
    build?: string;
}): Promise<void> {
    const { apifyClient, actorId, input, build } = params;

    let response: { status: number; data: unknown };
    try {
        response = await apifyClient.httpClient.axios.request({
            url: `${getApifyAPIBaseUrl()}/v2/actors/${encodeURIComponent(actorId)}/validate-input`,
            method: 'POST',
            params: build ? { build } : undefined,
            data: input,
            timeout: VALIDATE_INPUT_TIMEOUT_MSEC,
            validateStatus: null,
        });
    } catch (err) {
        logHttpError(err, 'validate-input request failed, proceeding without it', { actorId });
        return;
    }

    if (response.status !== 400) {
        if (response.status !== 200) {
            log.debug('validate-input responded unexpectedly, proceeding without it', {
                actorId,
                status: response.status,
            });
        }
        return;
    }

    const body = response.data as ValidateInputErrorBody;
    throw new ActorInputValidationError(body?.error?.message || DEFAULT_INVALID_INPUT_MESSAGE);
}
