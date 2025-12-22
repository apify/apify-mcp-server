# Algolia Search Response Analysis

This document contains insights about Algolia API responses for each documentation source. This information helps understand the data structure returned by Algolia and informs decisions about response processing logic.

## Key Findings

### URL Handling
- **All hits always have `url_without_anchor`** ✓
- No need to skip hits for missing URLs (the check can be simplified or removed)
- The `url_without_anchor` field is always populated across all documentation sources

### Anchor/Fragment Field
- **Initial finding** (search: "api"): No hits had anchors
- **Updated finding** (search: "actor"): **80% of Apify hits have anchors** (16/20 hits)
- **Fragment Distribution**:
  - Apify source: 80% of results include anchors pointing to specific sections
  - Same URLs appear multiple times with different anchors (e.g., `/actors` page has 4 different section anchors)
  - Crawlee sources: No anchors (due to `typeFilter: 'lvl1'` which returns page-level only)
- **Decision**: Fragments are important for Apify source and should be preserved in results

### Content Field

| Source | Has Content | Count | Note |
|--------|------------|-------|------|
| **apify** | ✓ YES | 20/20 (100%) | Always has content provided in full text |
| **crawlee-js** | ✗ NO | 0/3 (0%) | Content is `null`, must use hierarchy |
| **crawlee-py** | ✗ NO | 0/20 (0%) | Content is `null`, must use hierarchy |

### Hierarchy Field
- **All hits have hierarchy object** with fields: `lvl0`, `lvl1`, `lvl2`, `lvl3`, `lvl4`, `lvl5`, `lvl6`
- Most of these fields are `null` in responses
- Only the first 1-2 levels typically contain values
- **Apify source**: Has `content` field, so hierarchy is used less
- **Crawlee sources**: No `content` field, must rely on hierarchy for display

## Data Structure Examples

### Raw Algolia Response (Apify with fragments)
```json
{
  "url_without_anchor": "https://docs.apify.com/platform/actors",
  "anchor": "actors-overview",
  "content": "Actors are serverless cloud programs that can perform anything...",
  "type": "content",
  "hierarchy": { "lvl0": "Platform", "lvl1": "Actors", ... }
}
```

### Processed Result (After processAlgoliaResponse)
```json
{
  "url": "https://docs.apify.com/platform/actors#actors-overview",
  "content": "Actors are serverless cloud programs that can perform anything..."
}
```

### Multiple Sections Same Page
When searching "actor", the Apify index returns multiple hits from the same page with different anchors:
```
https://docs.apify.com/platform/actors#actors-overview
https://docs.apify.com/platform/actors#actor-components
https://docs.apify.com/platform/actors#build-actors
https://docs.apify.com/platform/actors#running-actors
```

This gives LLM access to different sections of the same page.

### Crawlee (No fragments)
```json
// Raw Algolia Response
{
  "url_without_anchor": "https://crawlee.dev/js/api",
  "anchor": "",
  "content": null,
  "type": "lvl1"
}

// Processed Result
{
  "url": "https://crawlee.dev/js/api"
  // Note: no content field since Crawlee doesn't provide it
}
```

## Simplification & Design Decisions

### Fragment Handling Strategy
**Decision**: Embed fragments directly in returned URLs instead of returning as separate field.

**Rationale**:
- Simpler type definition (`ApifyDocsSearchResult` has only `url` and `content`)
- LLM receives ready-to-use URLs (e.g., `https://docs.apify.com/actors#build-actors`)
- Fetch tool already handles fragments correctly (splits on `#`)
- No need for complex logic to reconstruct URL+fragment

**Implementation**:
```typescript
// Returns:
{ url: "https://docs.apify.com/actors#build-actors", content: "..." }

// Instead of:
{ url: "https://docs.apify.com/actors", fragment: "build-actors", content: "..." }
```

### Content Strategy
- **Use Algolia content directly** - Always populated for Apify, never for Crawlee
- **Remove hierarchy fallback** - Simplified approach, no hierarchy-based content synthesis
- **Result**: 
  - Apify search results include both URL (with anchor) and content
  - Crawlee search results include URL only (content is not available)

### Configuration Cleanup
- Removed `supportsFragments` property from DOCS_SOURCES config
- Simplified typeFilter comments (no longer need to explain fragment filtering)

### Code Simplification
**processAlgoliaResponse() went from ~45 lines to ~20 lines:**
- Removed fragment/hierarchy processing logic
- Removed supportsFragments checks
- URL building: `hit.url_without_anchor + (hit.anchor ? '#' + hit.anchor : '')`
- Content: `hit.content` (use as-is if present)
