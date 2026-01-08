# Resources Directory Index

This directory contains useful documents and insights about the repository architecture, design decisions, and implementation details that don't belong in code comments or JSDoc.

## Files

### [ALGOLIA.md](./ALGOLIA.md)
Technical analysis of Algolia search API responses for each documentation source.
- Data structure overview for each doc source (apify, crawlee-js, crawlee-py)
- Field availability patterns (content, hierarchy, anchors)
- Example response payloads
- Recommendations for response processing logic
- **Use case**: Understand what data is actually returned by Algolia to inform simplification decisions

### [MCP_SERVER_REFACTOR_ANALYSIS.md](./MCP_SERVER_REFACTOR_ANALYSIS.md)
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
