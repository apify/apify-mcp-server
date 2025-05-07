import { createMCPStdioClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';

createIntegrationTestsSuite({
    suiteName: 'MCP STDIO',
    createClientFn: createMCPStdioClient,
});
