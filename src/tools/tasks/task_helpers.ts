import type { Task, TaskPublicConfig } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { getResourceByIdOrName, isAmbiguousResourceId, toSafeResourceId } from '../../utils/apify_resource_id.js';
import { toIsoString } from '../actors/actor_run_response.js';

const PUBLIC_CONFIG_FIELDS = [
    'seoTitle',
    'seoDescription',
    'inputSchemaFields',
    'datasetName',
    'datasetView',
] as const satisfies (keyof Omit<TaskPublicConfig, 'publishedAt'>)[];

/** Fetches a task by ID, name, or `username/name`. */
export async function getTaskByIdOrName(client: ApifyClient, idOrName: string): Promise<Task | undefined> {
    return getResourceByIdOrName(idOrName, async (safeId) => client.task(safeId).get());
}

/**
 * Task names must be DNS-safe and 3-63 characters, as the API enforces. Validated here so the
 * caller gets a usable message instead of a 400.
 */
const TASK_NAME_REGEX = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/;

export const taskNameSchema = z
    .string()
    .min(3)
    .max(63)
    .regex(
        TASK_NAME_REGEX,
        'Task name may contain only letters, digits and dashes, and cannot start or end with a dash',
    );

/**
 * Writable public display configuration, shared by the create and update tools.
 *
 * The SEO length caps mirror the API's own, which it enforces on every `publicConfig` write and not
 * just at publish time, so rejecting here costs the user nothing.
 */
export const publicConfigSchema = z.object({
    seoTitle: z
        .string()
        .max(60)
        .optional()
        .describe('Title shown on the public landing page and in search results. At most 60 characters.'),
    seoDescription: z
        .string()
        .max(160)
        .optional()
        .describe('Description shown on the public landing page. Required to publish. At most 160 characters.'),
    inputSchemaFields: z
        .array(z.string())
        .optional()
        .describe(
            'Names of the input fields to display on the public page. At least one valid field is required to publish; the names must exist in the task input.',
        ),
    datasetName: z.string().optional().describe('Name of the dataset whose schema provides the views.'),
    datasetView: z
        .string()
        .optional()
        .describe(
            "View key from the Actor's dataset schema. Required to publish; ask the user, no tool lists dataset views.",
        ),
});

/**
 * The task subset returned by every task tool: identity, publication state, display config, and the
 * input verbatim — secret fields arrive from the API as `ENCRYPTED_VALUE:` placeholders, so nothing
 * is redacted here.
 */
export function taskResult(task: Task) {
    const publicConfig = task.publicConfig
        ? Object.fromEntries(
              PUBLIC_CONFIG_FIELDS.filter((field) => task.publicConfig?.[field] !== undefined).map((field) => [
                  field,
                  task.publicConfig?.[field],
              ]),
          )
        : null;

    return {
        taskId: task.id,
        actorId: task.actId,
        name: task.name,
        title: task.title ?? null,
        description: task.description ?? null,
        // Normalized because the client parses this into a `Date` while the raw publication call
        // returns a string; the declared output schema promises a string either way.
        publishedAt: toIsoString(task.publicConfig?.publishedAt) ?? null,
        publicConfig,
        input: task.input ?? null,
    };
}

/**
 * Setting the publication state the task already has is a no-op, so both directions are safe
 * to repeat.
 */
export async function setTaskPublication(client: ApifyClient, taskId: string, isPublic: boolean): Promise<Task> {
    // An ambiguous value is resolved to the real ID by lookup; on a miss it falls through to the
    // ID reading so the publish call raises the API's own not-found error.
    const resolvedId = isAmbiguousResourceId(taskId) ? (await getTaskByIdOrName(client, taskId))?.id : undefined;
    const taskClient = client.task(resolvedId ?? toSafeResourceId(taskId));
    return isPublic ? taskClient.publish() : taskClient.unpublish();
}
