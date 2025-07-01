import { createMcpStdioClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';

createIntegrationTestsSuite({
    suiteName: 'MCP stdio',
    transport: 'stdio',
    createClientFn: createMcpStdioClient,
});
