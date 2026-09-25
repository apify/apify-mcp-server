/**
 * A small OpenAPI document shaped like https://docs.apify.com/api/openapi.json: `$ref` parameters and
 * bodies, examples and `x-*` extensions, and one operation of each kind the API tools treat differently.
 */
export const API_SPEC_FIXTURE = {
    openapi: '3.1.2',
    paths: {
        '/v2/datasets/{datasetId}': {
            get: {
                operationId: 'dataset_get',
                summary: 'Get dataset',
                tags: ['Storage/Datasets'],
                parameters: [{ $ref: '#/components/parameters/datasetId' }],
                'x-js-name': 'get',
            },
            put: {
                operationId: 'dataset_put',
                summary: 'Update dataset',
                tags: ['Storage/Datasets'],
                parameters: [{ $ref: '#/components/parameters/datasetId' }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/UpdateDatasetRequest' },
                            examples: { common: { value: { name: 'leads' } } },
                        },
                    },
                },
            },
            delete: {
                operationId: 'dataset_delete',
                summary: 'Delete dataset',
                tags: ['Storage/Datasets'],
                parameters: [{ $ref: '#/components/parameters/datasetId' }],
            },
        },
        '/v2/datasets/{datasetId}/items': {
            get: {
                operationId: 'dataset_items_get',
                summary: 'Get dataset items',
                tags: ['Storage/Datasets'],
                parameters: [
                    { $ref: '#/components/parameters/datasetId' },
                    { name: 'limit', in: 'query', schema: { type: 'integer' } },
                    { name: 'format', in: 'query', required: true, schema: { type: 'string' } },
                    { name: 'Accept-Encoding', in: 'header', schema: { type: 'string' } },
                ],
            },
            head: { operationId: 'dataset_items_head', summary: 'Get dataset items headers' },
        },
        '/v2/actor-runs/{runId}/dataset': {
            put: {
                operationId: 'actorRun_dataset_put',
                summary: 'Update default dataset',
                tags: ['Default dataset'],
                parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: {
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateDatasetRequest' } } },
                },
            },
        },
        '/v2/actor-runs/{runId}': {
            get: {
                operationId: 'actorRun_get',
                summary: 'Get run',
                tags: ['Actor runs'],
                parameters: [
                    { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'waitForFinish', in: 'query', schema: { type: 'number' } },
                ],
            },
        },
        '/v2/actor-runs/{runId}/abort': {
            post: {
                operationId: 'actorRun_abort_post',
                summary: 'Abort run',
                tags: ['Actor runs'],
                parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
            },
        },
        '/v2/actors/{actorId}': {
            put: {
                operationId: 'actor_put',
                summary: 'Update Actor',
                tags: ['Actors'],
                parameters: [{ $ref: '#/components/parameters/actorId' }],
                requestBody: {
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateActorRequest' } } },
                },
            },
        },
        '/v2/actors/{actorId}/runs/{runId}': {
            get: {
                operationId: 'actors_run_get',
                summary: 'Get run',
                deprecated: true,
                parameters: [{ $ref: '#/components/parameters/actorId' }],
            },
        },
        '/v2/actors/{actorId}/run-sync': {
            get: {
                operationId: 'actor_runSync_get',
                summary: 'Run Actor synchronously without input',
                tags: ['Actors/Actor runs'],
                parameters: [{ $ref: '#/components/parameters/actorId' }],
            },
        },
        '/v2/key-value-stores/{storeId}/records/{recordKey}': {
            put: {
                operationId: 'keyValueStore_record_put',
                summary: 'Store record',
                tags: ['Storage/Key-value stores'],
                parameters: [
                    { name: 'storeId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'recordKey', in: 'path', required: true, schema: { type: 'string' } },
                ],
                requestBody: {
                    required: true,
                    content: { '*/*': { schema: { type: 'object', additionalProperties: true } } },
                },
            },
        },
        '/v2/users/me/limits': {
            put: {
                operationId: 'users_me_limits_put',
                summary: 'Update limits',
                tags: ['Users/Usage'],
                requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
            },
        },
        '/v2/webhooks': {
            get: { operationId: 'webhooks_get', summary: 'Get list of webhooks', tags: ['Webhooks/Webhooks'] },
        },
        '/v2/actors/{actorId}/webhooks': {
            get: {
                operationId: 'actor_webhooks_get',
                summary: 'Get list of webhooks',
                tags: ['Actors/Webhook collection'],
                parameters: [{ $ref: '#/components/parameters/actorId' }],
            },
        },
        '/outside/v2': { get: { operationId: 'outside_get', summary: 'Outside the API' } },
        '/v2/broken': { get: { summary: 'No operation ID' } },
    },
    components: {
        parameters: {
            datasetId: {
                name: 'datasetId',
                in: 'path',
                required: true,
                description: 'Dataset ID or username~dataset-name.',
                schema: { type: 'string', example: 'WkzbQMuFYuamGv3YF' },
            },
            actorId: {
                name: 'actorId',
                in: 'path',
                required: true,
                description: 'Actor ID or username~actor-name.',
                schema: { type: 'string' },
            },
        },
        schemas: {
            UpdateDatasetRequest: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    generalAccess: { type: 'string' },
                    example: { type: 'string', description: 'A property that happens to be named example.' },
                },
            },
            UpdateActorRequest: {
                allOf: [{ $ref: '#/components/schemas/ActorPermissionFields' }],
                properties: {
                    title: { type: 'string' },
                    isPublic: { type: 'boolean' },
                    pricingInfos: { type: 'array' },
                },
            },
            ActorPermissionFields: {
                type: 'object',
                properties: { actorPermissionLevel: { type: 'string' } },
            },
        },
    },
};
