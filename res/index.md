# Resources Directory Index

This directory contains useful documents and insights about the repository architecture, design decisions, and implementation details that don't belong in code comments or JSDoc.

## Files

### [algolia-analysis.md](./algolia.md)
Technical analysis of Algolia search API responses for each documentation source.
- Data structure overview for each doc source (apify, crawlee-js, crawlee-py)
- Field availability patterns (content, hierarchy, anchors)
- Example response payloads
- Recommendations for response processing logic
- **Use case**: Understand what data is actually returned by Algolia to inform simplification decisions

### [mcp-server-refactor-analysis.md](./mcp-server-refactor-analysis.md)
Implementation plan for migrating from low-level `Server` to high-level `McpServer` API.

**Structure:**
1. **Executive Summary** - High-level overview for stakeholders
2. **Executive Implementation Plan** - Technical summary for developers
3. **Detailed Implementation Guide** - Step-by-step guide for coding agents

**Key approach:** Callback-per-tool architecture where each tool's callback encapsulates its execution logic.

**Estimated effort:** 8-13 developer days

- Feature preservation matrix
- Code examples (before/after)
- Migration steps with specific file changes
- Testing strategy
- **Use case**: Reference for implementing the MCP SDK migration

### [mcp-resources-analysis.md](./mcp-resources-analysis.md)
Current MCP resources behavior and constraints (Skyfire readme and OpenAI widgets).
- Handler locations and low-level MCP usage
- Resource list/read behavior and error handling
- **Use case**: Baseline reference before refactoring resources

### [mcp-resources-refactor-analysis.md](./mcp-resources-refactor-analysis.md)
Refactor plan for modularizing existing resource handling (no new resources).
- Minimal resource service API (list/read/templates)
- Behavior-preserving steps and non-goals
- **Use case**: Step-by-step guide for refactoring without behavior change

### [tool-mode-separation-plan.md](./tool-mode-separation-plan.md)
Implementation plan for separating UI-mode (OpenAI) and normal-mode tool behavior into independent modules.

**Key approach:** Actor Executor pattern + separate tool definitions per mode + shared core logic layer.

**Estimated effort:** 6-10 developer days

- Design decisions table (actor-mcp passthrough, Skyfire freeze, task lifecycle, etc.)
- Three-layer architecture (core → registry → mode-specific tools)
- Actor Executor pattern for direct actor tools (`type: 'actor'`) mode awareness
- Tool definition immutability via `Object.freeze` (Skyfire safety)
- Mode-aware category registry eliminating deep-clone hack
- 5-phase migration plan with chained PR strategy (7 PRs)
- Directory structure and complete file manifest with PR assignments
- **Use case**: Reference for implementing the UI/normal mode tool separation

### [patterns-for-simplification.md](./patterns-for-simplification.md)
Analysis of patterns from the **official TypeScript MCP SDK** and **FastMCP** framework that could simplify the codebase.

**Key patterns identified:**
1. **Callback-Per-Tool Registration** - Eliminate central dispatcher (~250 LOC reduction)
2. **Unified Tool Context** - Cleaner tool execution interface
3. **Zod-First Validation** - Replace AJV with direct Zod validation
4. **Automatic Notifications** - Self-managing tool list changes
5. **Progress via Context** - Simplified progress reporting
6. **Structured Error Handling** - Consistent UserError pattern
7. **Type-Safe Registration** - Generic tool definitions
8. **Session-Aware Operations** - Context-based session access

**Estimated total effort:** 10-14 days for full implementation

- Prioritized implementation phases
- Before/after code examples
- Benefits for each pattern
- **Use case**: Reference for incremental codebase improvements

---

## Purpose

Resources in this directory serve as:
- **Technical references** for complex subsystems (e.g., Algolia integration)
- **Decision documentation** explaining why certain approaches were chosen
- **Data analysis** for optimization and refactoring efforts
- **Integration guides** for external services and APIs

## Guidelines

- Keep documents **short and technical** - avoid duplicating code logic
- Focus on **insights and patterns** rather than implementation details
- Use **tables, examples, and structured data** for clarity
- Link to relevant source files when explaining code flow
- Update when making significant changes to documented systems
