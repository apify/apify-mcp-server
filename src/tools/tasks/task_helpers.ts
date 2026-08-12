import type { Task, TaskPublicConfig } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { toIsoString } from '../actors/actor_run_response.js';

const PUBLIC_CONFIG_FIELDS = [
    'seoTitle',
    'seoDescription',
    'inputSchemaFields',
    'datasetName',
    'datasetView',
] as const satisfies (keyof Omit<TaskPublicConfig, 'publishedAt'>)[];

/**
 * Task names must be DNS-safe and 3-63 characters — mirrors `ActorTaskSchema` in apify-core, whose
 * constraints the API enforces. Validated here so the caller gets a usable message instead of a 400.
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

/** Writable public display configuration, shared by the create and update tools. */
export const publicConfigSchema = z.object({
    seoTitle: z.string().optional().describe('Title shown on the public landing page and in search results.'),
    seoDescription: z.string().optional().describe('Description shown on the public landing page.'),
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
        .describe("View key from the Actor's dataset schema. Required to publish the task."),
});

/**
 * The task subset returned by every task tool: identity, publication state, and the display
 * config. Input *values* are deliberately omitted — they may hold secrets — but the field names
 * are included because `publicConfig.inputSchemaFields` must reference them.
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
        inputFields: task.input && !Array.isArray(task.input) ? Object.keys(task.input) : [],
    };
}

/**
 * Setting the publication state the task already has is a no-op, so both directions are safe
 * to repeat.
 */
export async function setTaskPublication(client: ApifyClient, taskId: string, isPublic: boolean): Promise<Task> {
    const taskClient = client.task(taskId);
    return isPublic ? taskClient.publish() : taskClient.unpublish();
}
