// TEMPORARY — AI-GENERATED — NOT HUMAN-MAINTAINED. See tests/e2e/README.md.
// One shard of the v1 behaviour pin. Separate files so vitest runs them in parallel workers;
// the probes block on spawnSync, so in-file concurrency cannot help. All logic is in runner.ts.
import { defineMcpcShard, SHARD_COUNT } from './runner.js';

defineMcpcShard(5, SHARD_COUNT);
