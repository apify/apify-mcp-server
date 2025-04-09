export type Input = {
    actors: string[] | string;
    enableActorAutoLoading?: boolean;
    maxActorMemoryBytes?: number;
    debugActor?: string;
    debugActorInput?: unknown;
};

export interface ActorRunData {
    id?: string;
    actId?: string;
    userId?: string;
    startedAt?: string;
    finishedAt: null;
    status: 'RUNNING';
    meta: {
        origin?: string;
    };
    options: {
        build?: string;
        memoryMbytes?: string;
    };
    buildId?: string;
    defaultKeyValueStoreId?: string;
    defaultDatasetId?: string;
    defaultRequestQueueId?: string;
    buildNumber?: string;
    containerUrl?: string;
    standbyUrl?: string;
}
