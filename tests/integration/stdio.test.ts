import { createStdioClientPool } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';

const stdioClientPool = createStdioClientPool();

createIntegrationTestsSuite({
    suiteName: 'MCP stdio',
    transport: 'stdio',
    createClientFn: stdioClientPool.createClient,
    afterAllFn: stdioClientPool.closeAll,
});
