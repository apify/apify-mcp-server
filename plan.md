# Implementation Plan: Simplify `call-actor` Tool

## Summary
Remove two-step workflow from `call-actor` tool. Make it execution-only. Move info retrieval to `fetch-actor-details` with new `output` parameter for token optimization.

**Status**: Approved - Ready for Implementation  
**Breaking Change**: YES - Hard break, remove `step` parameter  
**Estimated Effort**: 8-10 hours

---

## Key Decisions Made

1. **Default output**: `['description', 'stats', 'pricing', 'readme', 'input-schema']` (comprehensive, backwards compatible)
2. **MCP tools on non-MCP actors**: Return note "This Actor is not an MCP server" (graceful, no error)
3. **Breaking change strategy**: Hard break - no deprecation period
4. **Telemetry**: No telemetry for output parameter usage
5. **Documentation**: Minimal updates, no workflow examples, no tool options documentation

---

## Core Changes

### 1. `fetch-actor-details` Tool Enhancement
**File**: `src/tools/fetch-actor-details.ts`

#### Schema Changes
```typescript
const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: z.array(z.enum(['description', 'stats', 'pricing', 'input-schema', 'readme', 'mcp-tools']))
        .optional()
        .default(['description', 'stats', 'pricing', 'readme', 'input-schema'])
        .describe(`Specify which information to include in the response. Options:
- 'description': Actor title, description, and basic info
- 'stats': Usage statistics and ratings
- 'pricing': Pricing model and costs
- 'input-schema': Required input parameters schema
- 'readme': Full README documentation
- 'mcp-tools': List of available tools (only for MCP server Actors)

Default: ['description', 'stats', 'pricing', 'readme', 'input-schema']. Use specific options to save tokens.`),
});
```

#### Implementation Logic

**Conditional response building**:
```typescript
const texts: string[] = [];
const parsed = fetchActorDetailsToolArgsSchema.parse(args);

// Build actor card only if description/stats/pricing requested
const needsCard = parsed.output.some(o => ['description', 'stats', 'pricing'].includes(o));
if (needsCard) {
    texts.push(`# Actor information\n${details.actorCard}`);
}

// Add README if requested
if (parsed.output.includes('readme')) {
    texts.push(`${details.readme}`);
}

// Add input schema if requested
if (parsed.output.includes('input-schema')) {
    texts.push(`# [Input schema](${actorUrl}/input)\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``);
}

// Handle MCP tools
if (parsed.output.includes('mcp-tools')) {
    const mcpServerUrl = await getActorMcpUrlCached(parsed.actor, apifyClient);
    if (mcpServerUrl && typeof mcpServerUrl === 'string') {
        // Check Skyfire mode restriction
        if (apifyMcpServer.options.skyfireMode) {
            texts.push(`This Actor is an MCP server and cannot be accessed in Skyfire mode.`);
        } else {
            // Connect and list tools
            const client = await connectMCPClient(mcpServerUrl, apifyToken);
            const toolsResponse = await client.listTools();
            
            const mcpToolsInfo = toolsResponse.tools.map((tool) => 
                `**${tool.name}**\n${tool.description || 'No description'}\nInput schema:\n\`\`\`json\n${JSON.stringify(tool.inputSchema)}\n\`\`\``
            ).join('\n\n');
            
            texts.push(`# Available MCP Tools\nThis Actor is an MCP server with ${toolsResponse.tools.length} tools.\nTo call a tool, use: "${parsed.actor}:{toolName}"\n\n${mcpToolsInfo}`);
            
            await client.close();
        }
    } else {
        // Not an MCP server - graceful handling
        texts.push(`Note: This Actor is not an MCP server and does not expose MCP tools.`);
    }
}
```

**Structured output update**:
```typescript
const structuredContent: any = {
    actorInfo: parsed.output.some(o => ['description', 'stats', 'pricing'].includes(o)) 
        ? details.actorCardStructured 
        : undefined,
    readme: parsed.output.includes('readme') ? details.readme : undefined,
    inputSchema: parsed.output.includes('input-schema') ? details.inputSchema : undefined,
};
```

### 2. `call-actor` Tool Simplification
**File**: `src/tools/actor.ts`

#### Schema Changes (lines 336-356)
```typescript
const callActorArgs = z.object({
    actor: z.string()
        .describe(`The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").

For MCP server Actors (Actors that expose multiple tools), use the format "actorName:toolName" to call a specific tool.
Example: "apify/actors-mcp-server:fetch-apify-docs" calls the fetch-apify-docs tool from the apify/actors-mcp-server Actor.

Use the fetch-actor-details tool with output=['mcp-tools'] to list available tools for MCP server Actors.`),
    input: z.object({}).passthrough()
        .describe(`The input JSON to pass to the Actor. Required.

IMPORTANT: Use fetch-actor-details tool with output=['input-schema'] first to understand the required input parameters.`),
    callOptions: z.object({
        memory: z.number()
            .min(128, 'Memory must be at least 128 MB')
            .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
            .optional()
            .describe(`Memory allocation for the Actor in MB. Must be a power of 2 (e.g., 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768). Minimum: 128 MB, Maximum: 32768 MB (32 GB).`),
        timeout: z.number()
            .min(0, 'Timeout must be 0 or greater')
            .optional()
            .describe(`Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated. Use 0 for infinite timeout (no time limit). Minimum: 0 seconds (infinite).`),
    }).optional()
        .describe('Optional call options for the Actor run configuration.'),
});
```

#### Description Update (lines 358-389)
```typescript
description: `Call any Actor from the Apify Store.

WORKFLOW:
1. Use fetch-actor-details with output=['input-schema'] to get the Actor's input schema (recommended to save tokens)
2. Call this tool with the actor name and proper input based on the schema

For MCP server Actors:
- Use fetch-actor-details with output=['mcp-tools'] to list available tools
- Call using format: "actorName:toolName" (e.g., "apify/actors-mcp-server:fetch-apify-docs")

IMPORTANT:
- Typically returns a datasetId and preview of output items
- Use get-actor-output tool with the datasetId to fetch full results
- Use dedicated Actor tools when available (e.g., apify-slash-rag-web-browser) for better experience

There are two ways to run Actors:
1. Dedicated Actor tools (e.g., ${actorNameToToolName('apify/rag-web-browser')}): These are pre-configured tools, offering a simpler and more direct experience.
2. Generic call-actor tool (${HelperTools.ACTOR_CALL}): Use this when a dedicated tool is not available or when you want to run any Actor dynamically. This tool is especially useful if you do not want to add specific tools or your client does not support dynamic tool registration.

EXAMPLES:
- user_input: Get instagram posts using apify/instagram-scraper`,
```

#### Implementation Changes (lines 404-606)

**Remove**:
- Line 409: `const performStep = input && step !== 'call' ? 'call' : step;`
- Lines 437-485: All `step="info"` handling logic

**Keep**:
- Lines 487-506: Skyfire mode handling
- Lines 507-606: Actor execution logic (current `step="call"` path)

**Update error message** (line 508-513):
```typescript
if (!input) {
    return buildMCPResponse({
        texts: [`Input is required. Please provide the input parameter based on the Actor's input schema. Use fetch-actor-details tool with output=['input-schema'] to get the Actor's input schema first.`],
        isError: true,
    });
}
```

---

## Breaking Changes

### Before (OLD)
```typescript
// Step 1: Get schema
await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'apify/example', step: 'info' }
});

// Step 2: Execute
await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'apify/example', step: 'call', input: {...} }
});

// MCP Server - Step 1
await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'apify/actors-mcp-server', step: 'info' }
});

// MCP Server - Step 2
await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'apify/actors-mcp-server:fetch-apify-docs', step: 'call', input: {...} }
});
```

### After (NEW)
```typescript
// Step 1: Get schema (token-optimized)
await client.callTool({
    name: 'fetch-actor-details',
    arguments: { actor: 'apify/example', output: ['input-schema'] }
});

// Step 2: Execute
await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'apify/example', input: {...} }
});

// MCP Server - Step 1
await client.callTool({
    name: 'fetch-actor-details',
    arguments: { actor: 'apify/actors-mcp-server', output: ['mcp-tools'] }
});

// MCP Server - Step 2
await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'apify/actors-mcp-server:fetch-apify-docs', input: {...} }
});
```

---

## Edge Cases & Issues

### 1. LLM calls `call-actor` without fetching schema first
- **Issue**: Input validation fails with AJV error
- **Mitigation**: Error message includes: "Use fetch-actor-details tool with output=['input-schema'] to get the Actor's input schema first."

### 2. MCP server Actors without tool name
- **Issue**: `actor: "apify/actors-mcp-server"` without `:toolName` suffix in execution
- **Current**: Already handled with `CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG` (line 521-523)
- **Action**: No change needed, keep existing check

### 3. Skyfire mode + MCP servers
- **Issue**: MCP servers (standby Actors) not supported in Skyfire mode
- **Current**: Already blocked in `call-actor` (lines 428-434)
- **Action**: Add same check to `fetch-actor-details` when `mcp-tools` requested

### 4. `output=['mcp-tools']` on regular Actor
- **Issue**: Actor doesn't expose MCP tools
- **Behavior**: Return note "This Actor is not an MCP server and does not expose MCP tools." (no error, graceful)

### 5. Backwards compatibility for `apify-mcp-server-internal`
- **Issue**: Hosted server may use `step` parameter in existing code
- **Impact**: Hard break requires coordinated deployment between repos
- **Timeline**: Must update both `@apify/actors-mcp-server` and `apify-mcp-server-internal` simultaneously
- **Migration required**: Replace all `call-actor step="info"` → `fetch-actor-details`

### 6. Missing input parameter
- **Issue**: LLM forgets to provide input
- **Behavior**: Validation error with helpful message suggesting `fetch-actor-details`

### 7. Empty output array
- **Issue**: `output: []` provided
- **Behavior**: Use default (return everything)

---

## Test Updates

### Add New Tests
**File**: `tests/integration/suite.ts`

1. **Test: `fetch-actor-details` with minimal output**
```typescript
it('should return only input schema when output=["input-schema"]', async () => {
    const result = await client.callTool({
        name: 'fetch-actor-details',
        arguments: { actor: ACTOR_PYTHON_EXAMPLE, output: ['input-schema'] }
    });
    const content = result.content as { text: string }[];
    // Should contain schema but NOT readme or actor card
    expect(content.some(item => item.text.includes('Input schema'))).toBe(true);
    expect(content.some(item => item.text.includes('README'))).toBe(false);
});
```

2. **Test: `fetch-actor-details` with selective output**
```typescript
it('should return only description and stats when specified', async () => {
    const result = await client.callTool({
        name: 'fetch-actor-details',
        arguments: { actor: ACTOR_PYTHON_EXAMPLE, output: ['description', 'stats'] }
    });
    const content = result.content as { text: string }[];
    // Should contain actor info but NOT readme or schema
    expect(content.some(item => item.text.includes('Actor information'))).toBe(true);
    expect(content.some(item => item.text.includes('Input schema'))).toBe(false);
});
```

3. **Test: MCP server with `output=['mcp-tools']`**
```typescript
it('should list MCP tools when output=["mcp-tools"] for MCP server Actor', async () => {
    const result = await client.callTool({
        name: 'fetch-actor-details',
        arguments: { actor: ACTOR_MCP_SERVER_ACTOR_NAME, output: ['mcp-tools'] }
    });
    const content = result.content as { text: string }[];
    expect(content.some(item => item.text.includes('Available MCP Tools'))).toBe(true);
    expect(content.some(item => item.text.includes('fetch-apify-docs'))).toBe(true);
});
```

4. **Test: Regular Actor with `output=['mcp-tools']` (graceful)**
```typescript
it('should return graceful note when output=["mcp-tools"] for regular Actor', async () => {
    const result = await client.callTool({
        name: 'fetch-actor-details',
        arguments: { actor: ACTOR_PYTHON_EXAMPLE, output: ['mcp-tools'] }
    });
    const content = result.content as { text: string }[];
    expect(content.some(item => item.text.includes('This Actor is not an MCP server'))).toBe(true);
});
```

### Update Existing Tests

**Test at line 447: "should enforce two-step process for call-actor tool"**

BEFORE:
```typescript
it('should enforce two-step process for call-actor tool', async () => {
    client = await createClientFn({ tools: ['actors'] });

    // Step 1: Get info (should work)
    const infoResult = await client.callTool({
        name: HelperTools.ACTOR_CALL,
        arguments: {
            actor: ACTOR_PYTHON_EXAMPLE,
            step: 'info',
        },
    });
    expect(infoResult.content).toBeDefined();
    const content = infoResult.content as { text: string }[];
    expect(content.some((item) => item.text.includes('Input schema'))).toBe(true);

    // Step 2: Call with proper input (should work)
    const callResult = await client.callTool({
        name: HelperTools.ACTOR_CALL,
        arguments: {
            actor: ACTOR_PYTHON_EXAMPLE,
            step: 'call',
            input: { first_number: 1, second_number: 2 },
        },
    });
    expect(callResult.content).toBeDefined();
});
```

AFTER:
```typescript
it('should call Actor directly with required input', async () => {
    client = await createClientFn({ tools: ['actors'] });

    // Should fail without input
    const noInputResult = await client.callTool({
        name: HelperTools.ACTOR_CALL,
        arguments: {
            actor: ACTOR_PYTHON_EXAMPLE,
        },
    });
    expect(noInputResult.isError).toBe(true);
    const errorContent = noInputResult.content as { text: string }[];
    expect(errorContent.some(item => item.text.includes('fetch-actor-details'))).toBe(true);

    // Should succeed with input
    const callResult = await client.callTool({
        name: HelperTools.ACTOR_CALL,
        arguments: {
            actor: ACTOR_PYTHON_EXAMPLE,
            input: { first_number: 1, second_number: 2 },
        },
    });
    expect(callResult.content).toBeDefined();
});
```

**Test at line 577: "should call MCP server Actor via call-actor and invoke fetch-apify-docs tool"**

BEFORE:
```typescript
it('should call MCP server Actor via call-actor and invoke fetch-apify-docs tool', async () => {
    client = await createClientFn({ tools: ['actors'] });

    // Step 1: info - ensure the MCP server Actor lists tools including fetch-apify-docs
    const infoResult = await client.callTool({
        name: HelperTools.ACTOR_CALL,
        arguments: {
            actor: ACTOR_MCP_SERVER_ACTOR_NAME,
            step: 'info',
        },
    });

    expect(infoResult.content).toBeDefined();
    const infoContent = infoResult.content as { text: string }[];
    expect(infoContent.some((item) => item.text.includes('fetch-apify-docs'))).toBe(true);

    // Step 2: call - invoke the MCP tool fetch-apify-docs via actor:tool syntax
    const DOCS_URL = 'https://docs.apify.com';
    const callResult = await client.callTool({
        name: HelperTools.ACTOR_CALL,
        arguments: {
            actor: `${ACTOR_MCP_SERVER_ACTOR_NAME}:fetch-apify-docs`,
            step: 'call',
            input: { url: DOCS_URL },
        },
    });

    expect(callResult.content).toBeDefined();
    const callContent = callResult.content as { text: string }[];
    expect(callContent.some((item) => item.text.includes(`Fetched content from ${DOCS_URL}`))).toBe(true);
});
```

AFTER:
```typescript
it('should call MCP server Actor via call-actor and invoke fetch-apify-docs tool', async () => {
    client = await createClientFn({ tools: ['actors'] });

    // Step 1: Get MCP tools using fetch-actor-details
    const detailsResult = await client.callTool({
        name: HelperTools.ACTOR_GET_DETAILS,
        arguments: {
            actor: ACTOR_MCP_SERVER_ACTOR_NAME,
            output: ['mcp-tools'],
        },
    });

    expect(detailsResult.content).toBeDefined();
    const detailsContent = detailsResult.content as { text: string }[];
    expect(detailsContent.some((item) => item.text.includes('fetch-apify-docs'))).toBe(true);

    // Step 2: call - invoke the MCP tool fetch-apify-docs via actor:tool syntax
    const DOCS_URL = 'https://docs.apify.com';
    const callResult = await client.callTool({
        name: HelperTools.ACTOR_CALL,
        arguments: {
            actor: `${ACTOR_MCP_SERVER_ACTOR_NAME}:fetch-apify-docs`,
            input: { url: DOCS_URL },
        },
    });

    expect(callResult.content).toBeDefined();
    const callContent = callResult.content as { text: string }[];
    expect(callContent.some((item) => item.text.includes(`Fetched content from ${DOCS_URL}`))).toBe(true);
});
```

**Test at line 1258: "should return error message when trying to call MCP server Actor without tool name in actor parameter"**

BEFORE:
```typescript
it('should return error message when trying to call MCP server Actor without tool name in actor parameter', async () => {
    client = await createClientFn({ tools: ['actors'] });

    const response = await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: ACTOR_MCP_SERVER_ACTOR_NAME,
            step: 'call',
            input: { url: 'https://docs.apify.com' },
        },
    });

    expect(response.content).toBeDefined();
    const content = response.content as { text: string }[];
    expect(content.length).toBeGreaterThan(0);
    expect(content[0].text).toContain(CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG);
    expect(response.isError).toBe(true);

    await client.close();
});
```

AFTER:
```typescript
it('should return error message when trying to call MCP server Actor without tool name in actor parameter', async () => {
    client = await createClientFn({ tools: ['actors'] });

    const response = await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: ACTOR_MCP_SERVER_ACTOR_NAME,
            input: { url: 'https://docs.apify.com' },
        },
    });

    expect(response.content).toBeDefined();
    const content = response.content as { text: string }[];
    expect(content.length).toBeGreaterThan(0);
    expect(content[0].text).toContain(CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG);
    expect(response.isError).toBe(true);

    await client.close();
});
```

### Update Evaluation Logic

**File**: `evals/run-evaluation.ts` (lines 102-129)

BEFORE:
```typescript
// Normalize tool names: treat call-actor with step="info" as equivalent to fetch-actor-details
const normalizedToolName = ((toolName: string) => {
    // Normalize call-actor to fetch-actor-details (bidirectional equivalence)
    if (toolName === 'call-actor' || toolName === 'fetch-actor-details') {
        return 'fetch-actor-details';
    }
    return toolName;
})();

// If it's call-actor with step="info", treat it as fetch-actor-details
if (toolName === 'call-actor') {
    const step = toolArgs.step;
    if (step === 'info') {
        return 'fetch-actor-details';
    }
}

// Normalize expected tools (both call-actor and fetch-actor-details → fetch-actor-details)
```

AFTER:
```typescript
// No special normalization needed - tools are independent
const normalizedToolName = toolName;
```

**File**: `evals/config.ts` (lines 94-99)

BEFORE:
```typescript
**call-actor**: Has a mandatory two-step workflow: step="info" first (gets Actor details), then step="call" (runs Actor).
- Calling with step="info" is CORRECT and required before execution
- Do NOT penalize the info step - it's part of the normal workflow

**fetch-actor-details**: Gets Actor documentation without running it. Overlaps with call-actor step="info".
- Both fetch-actor-details AND call-actor step="info" are valid for getting Actor parameters/details
```

AFTER:
```typescript
**call-actor**: Executes an Actor and returns results. Requires input parameter.
- Use fetch-actor-details first to get the Actor's input schema
- For MCP server Actors, use format "actorName:toolName"

**fetch-actor-details**: Gets Actor documentation, input schema, and details without running it.
- Use output parameter to request specific information (e.g., output=['input-schema'] for minimal response)
- Use output=['mcp-tools'] to list available tools for MCP server Actors
```

---

## Documentation Updates

### Constants File
**File**: `src/const.ts` (lines 214-230)

UPDATE `SERVER_INSTRUCTIONS`:
```typescript
export const SERVER_INSTRUCTIONS = `
...
## Tool dependencies and disambiguation

### Tool dependencies
- \`${HelperTools.ACTOR_CALL}\`:
  - Use \`${HelperTools.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema
  - Then call with proper input to execute the Actor
  - For MCP server Actors, use format "actorName:toolName" to call specific tools

### Tool disambiguation
- **${HelperTools.ACTOR_OUTPUT_GET} vs ${HelperTools.DATASET_GET_ITEMS}:**
  Use \`${HelperTools.ACTOR_OUTPUT_GET}\` for Actor run outputs and \`${HelperTools.DATASET_GET_ITEMS}\` for direct dataset access.
- **${HelperTools.STORE_SEARCH} vs ${HelperTools.ACTOR_GET_DETAILS}:**
  \`${HelperTools.STORE_SEARCH}\` finds Actors; \`${HelperTools.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.
- **${HelperTools.STORE_SEARCH} vs ${RAG_WEB_BROWSER}:**
  \`${HelperTools.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs ${HelperTools.ACTOR_CALL}:**
  Prefer dedicated tools when available; use \`${HelperTools.ACTOR_CALL}\` only when no specialized tool exists in Apify store.
`;
```

### README
**File**: `README.md`

**Line 159**: Update `call-actor` table row:
```markdown
| `call-actor`* | actors | Call an Actor and get its run results. Use fetch-actor-details first to get the Actor's input schema. | ❔ |
```

**Lines 177-181**: Remove/simplify note about two-step workflow:
```markdown
> **Note:**
>
> When using the `actors` tool category, clients that support dynamic tool discovery (like Claude.ai web and VS Code) automatically receive the `add-actor` tool instead of `call-actor` for enhanced Actor discovery capabilities.
```

---

## Implementation Checklist

### Code Changes
- [ ] **`fetch-actor-details.ts`**: Add `output` parameter with default `['description', 'stats', 'pricing', 'readme', 'input-schema']`
- [ ] **`fetch-actor-details.ts`**: Implement conditional response building based on `output` array
- [ ] **`fetch-actor-details.ts`**: Add MCP server detection using `getActorMcpUrlCached()`
- [ ] **`fetch-actor-details.ts`**: Implement MCP tools listing when `output` includes `mcp-tools`
- [ ] **`fetch-actor-details.ts`**: Add Skyfire mode check for MCP servers
- [ ] **`fetch-actor-details.ts`**: Add graceful note for `mcp-tools` on non-MCP actors
- [ ] **`fetch-actor-details.ts`**: Update structured output schema
- [ ] **`actor.ts`**: Remove `step` parameter from `callActorArgs` schema
- [ ] **`actor.ts`**: Make `input` parameter required (remove `.optional()`)
- [ ] **`actor.ts`**: Update `actor` parameter description (document `actorName:toolName` format)
- [ ] **`actor.ts`**: Update `input` parameter description (reference `fetch-actor-details`)
- [ ] **`actor.ts`**: Update tool description (remove two-step workflow, add new workflow)
- [ ] **`actor.ts`**: Remove line 409 (`performStep` variable)
- [ ] **`actor.ts`**: Remove lines 437-485 (all `step="info"` logic)
- [ ] **`actor.ts`**: Update error message for missing input (line 508-513)
- [ ] **`const.ts`**: Update `SERVER_INSTRUCTIONS`

### Tests
- [ ] **Add**: `fetch-actor-details` with `output=['input-schema']`
- [ ] **Add**: `fetch-actor-details` with `output=['description', 'stats']`
- [ ] **Add**: `fetch-actor-details` with `output=['mcp-tools']` for MCP server
- [ ] **Add**: `fetch-actor-details` with `output=['mcp-tools']` for regular Actor
- [ ] **Update**: Line 447 test (rename and refactor)
- [ ] **Update**: Line 577 test (use `fetch-actor-details` instead of `call-actor step="info"`)
- [ ] **Update**: Line 1258 test (remove `step` parameter)
- [ ] **Update**: `evals/run-evaluation.ts` (remove normalization logic)
- [ ] **Update**: `evals/config.ts` (update tool guidance)

### Documentation
- [ ] **Update**: `README.md` line 159 (call-actor description)
- [ ] **Update**: `README.md` lines 177-181 (remove two-step note)

### Validation
- [ ] Run `npm run type-check`
- [ ] Run `npm run build`
- [ ] Run `npm run test:unit`
- [ ] **Human-only**: Run `npm run test:integration` (requires `APIFY_TOKEN`)

---

## Files to Modify

### Core Implementation
1. `src/tools/fetch-actor-details.ts` - Add output parameter and MCP support
2. `src/tools/actor.ts` - Simplify call-actor tool
3. `src/const.ts` - Update SERVER_INSTRUCTIONS

### Tests
4. `tests/integration/suite.ts` - Update and add tests
5. `evals/run-evaluation.ts` - Remove normalization
6. `evals/config.ts` - Update guidance

### Documentation
7. `README.md` - Minimal updates

---

## Migration Guide for `apify-mcp-server-internal`

### Find and Replace Patterns

1. **Replace `call-actor step="info"` with `fetch-actor-details`**:
```bash
# Find
call-actor.*step.*info

# Replace with appropriate fetch-actor-details call
```

2. **Remove `step: 'call'` from all `call-actor` calls**:
```bash
# Find
step:\s*['"]call['"]

# Remove (including comma if present)
```

3. **Ensure all `call-actor` calls have `input` parameter**

### Testing After Migration
- Test regular Actor execution
- Test MCP server Actor tool listing
- Test MCP server Actor tool execution
- Verify error messages are helpful

---

## Risk Assessment

**Risk Level**: MEDIUM

### Risks
1. **Breaking change coordination**: Requires simultaneous update of both repos
2. **LLM adaptation**: LLMs need to learn new pattern (fetch-actor-details → call-actor)
3. **Test coverage**: Integration tests require human with APIFY_TOKEN

### Mitigation
1. Test thoroughly in staging before production deployment
2. Update both repos in coordinated release
3. Monitor error rates after deployment
4. Have rollback plan ready

---

## Estimated Effort

- **Code changes**: 4-5 hours
- **Test updates**: 2-3 hours
- **Documentation**: 1 hour
- **Validation**: 1 hour
- **Total**: 8-10 hours

---

## Notes

- Default output keeps full backwards compatibility (returns everything)
- Token optimization available via `output=['input-schema']`
- MCP server support adds powerful tool discovery to `fetch-actor-details`
- Clean separation: `fetch-actor-details` = read, `call-actor` = execute
- Consistent with tool design patterns (separate read/write operations)

---

**Last Updated**: 2026-01-06
**Status**: Ready for Implementation
