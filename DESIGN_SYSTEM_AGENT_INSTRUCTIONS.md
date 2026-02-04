# Design System Agent Instructions

**CRITICAL**: These instructions are MANDATORY for all UI/frontend work. Follow exactly as written.

## Pre-Work Checklist (BLOCKING REQUIREMENT)

Before ANY UI/component work:

1. **Check MCP availability**:
   - Search for `mcp__storybook__*` tools
   - Search for `mcp__figma__*` tools
   - If EITHER is missing: **STOP** and alert user to start required MCP server

2. **Load design context** (if MCPs available):
   ```
   Call: mcp__storybook__get-ui-building-instructions
   Call: mcp__figma__get_design_context (if working from designs)
   ```

3. **Read existing patterns**:
   - The Storybook MCP provides component examples and usage patterns
   - Find similar widgets/components in the project: `src/web/src/**/*{keyword}*.{tsx,ts}`
   - Use Grep to find token usage patterns: `theme\.color\.|theme\.space\.|theme\.radius\.`
   - Read 1-2 similar components in the project to understand patterns
   - DO NOT read more than 3 files for context

## Strict Rules (Zero Tolerance)

### 1. Design Tokens ONLY
**NEVER** hardcode values. Use `theme.*` exclusively:

```typescript
// ❌ FORBIDDEN
color: '#1976d2'
padding: '8px'
border-radius: '4px'
font-size: '14px'

// ✅ REQUIRED
color: ${theme.color.primary.action}
padding: ${theme.space.space8}
border-radius: ${theme.radius.radius8}
${theme.typography.shared.tablet.bodyMMedium}
```

**Token Reference** (understand the patterns):
- Colors: `theme.color.{category}.{property}`
  - Example categories: `neutral`, `primary`, `primaryBlack`, `success`, `warning`, `danger`
  - Example properties: `text`, `textMuted`, `background`, `backgroundSubtle`, `action`, `actionHover`, `border`, `icon`, etc.
- Spacing: `theme.space.space{N}`
  - Examples: `space8`, `space16`, `space24` (incremental values available)
- Radius: `theme.radius.radius{N}`
  - Examples: `radius4`, `radius6`, `radius8`, `radius12`, `radiusFull`
- Shadows: `theme.shadow.{name}`
  - Examples: `shadow1`, `shadow2`, `shadow3`, `shadowActive`
- Typography: `theme.typography.shared.{device}.{typeName}`
  - Devices: `mobile`, `tablet`, `desktop`
  - Examples: `bodyM`, `bodyMMedium`, `bodyS`, `titleL`, `codeM`

**To discover available tokens**: Use Storybook MCP or Grep existing usage in `src/web/src`

### 2. Component Imports
```typescript
// ✅ Import from ui-library
import { Button, Badge, Chip } from '@apify/ui-library';

// ❌ NEVER create duplicate components
// ❌ NEVER import from relative paths outside ui-library
```

### 3. Styled Components Pattern
```typescript
import styled from 'styled-components';
import { theme } from '@apify/ui-library';

// ✅ Correct pattern
const StyledComponent = styled.div<{ $variant?: string }>`
    color: ${theme.color.neutral.text};
    padding: ${theme.space.space16};

    ${({ $variant }) => $variant === 'primary' && css`
        background: ${theme.color.primary.background};
    `}
`;

// Note: Use $ prefix for transient props ($variant, $isActive, etc.)
```

### 4. Component Structure (Strict Order)
```typescript
// 1. Imports (grouped)
import { forwardRef } from 'react';
import styled from 'styled-components';
import { theme } from '@apify/ui-library';

// 2. Constants & Types
export const COMPONENT_VARIANTS = { ... } as const;
type ComponentVariants = ValueOf<typeof COMPONENT_VARIANTS>;

// 3. Styled Components
const StyledWrapper = styled.div`...`;

// 4. Component Implementation
export const Component = forwardRef<HTMLElement, Props>((props, ref) => {
    // implementation
});

// 5. Display Name
Component.displayName = 'Component';
```

### 5. Color Usage Rules

**Semantic Naming Required**:
- Text: `theme.color.{category}.text`, `.textMuted`, `.textSubtle`, `.textDisabled`
- Backgrounds: `theme.color.{category}.background`, `.backgroundSubtle`, `.backgroundMuted`
- Interactive: `theme.color.{category}.action`, `.actionHover`, `.actionActive`
- Borders: `theme.color.{category}.border`, `.separatorSubtle`, `.fieldBorder`
- Icons: `theme.color.{category}.icon`, `.iconSubtle`, `.iconDisabled`

**State Variants**:
```typescript
// Default → Hover → Active states
background: ${theme.color.primary.action};
&:hover { background: ${theme.color.primary.actionHover}; }
&:active { background: ${theme.color.primary.actionActive}; }
```

### 6. Spacing Rules
- Gaps between elements: `space4`, `space8`, `space12`
- Component padding: `space8`, `space12`, `space16`
- Section margins: `space16`, `space24`, `space32`
- Large layouts: `space40`, `space64`, `space80`

**NEVER** use arbitrary values like `gap: 10px` - round to nearest token.

### 7. Typography Rules
```typescript
// ✅ Use typography tokens (they include font-size, line-height, font-weight, font-family)
${theme.typography.shared.tablet.bodyM}
// or for responsive design:
${theme.device.mobile} {
    ${theme.typography.shared.mobile.bodyM}
}

// ❌ NEVER hardcode
font-size: 14px;
line-height: 1.5;
font-weight: 400;
```

**Note**: Typography tokens are complete CSS strings containing all font properties. You don't access individual properties like `.fontSize`.

## Verification Protocol (Before Submitting)

Run this mental checklist:

1. **Token Audit**: Search your code for:
   - Regex: `['"]#[0-9a-fA-F]{3,8}['"]` → Should be ZERO matches
   - Regex: `['"][0-9]+px['"]` → Should be ZERO matches (except in exceptional cases)
   - All `color:`, `background:`, `padding:`, `margin:`, `gap:` use `theme.*`

2. **Import Check**:
   - All styled-components import `theme` from `@apify/ui-library`
   - No duplicate component implementations

3. **Pattern Match**:
   - Compare your component structure to similar existing components
   - Follow same prop naming conventions
   - Use same variant patterns

## Common Pitfalls (Avoid These)

1. **❌ Mixing hardcoded and token values**
   ```typescript
   // ❌ WRONG
   padding: ${theme.space.space16} 10px;

   // ✅ CORRECT
   padding: ${theme.space.space16} ${theme.space.space10};
   ```

2. **❌ Using non-existent color properties**
   ```typescript
   // ❌ WRONG
   theme.color.neutral.textLight // doesn't exist
   theme.color.primary.main // doesn't exist

   // ✅ CORRECT
   theme.color.neutral.textMuted // use actual property names
   theme.color.primary.action // use actual property names
   ```

3. **❌ Skipping MCP context**
   - Always call Storybook MCP before starting
   - Don't assume you know the patterns

4. **❌ Over-reading for context**
   - Read max 3 similar components
   - Don't read entire directories
   - Use Grep to find specific patterns

## Figma Integration Workflow

When user provides Figma design:

1. **Get design context**:
   ```
   mcp__figma__get_design_context (with Figma URL)
   ```

2. **Extract design tokens**:
   - Colors → Map to `theme.color.*`
   - Spacing → Map to `theme.space.*`
   - Typography → Map to `theme.typography.*`

3. **Get screenshots if needed**:
   ```
   mcp__figma__get_screenshot (for visual reference)
   ```

4. **Verify variable mappings**:
   ```
   mcp__figma__get_variable_defs (to see Figma variables)
   ```

## Quick Reference Card

| Property | Token Pattern | Example |
|----------|---------------|---------|
| Text color | `theme.color.{cat}.{prop}` | `theme.color.neutral.text` |
| Background | `theme.color.{cat}.{prop}` | `theme.color.primary.background` |
| Padding/Margin | `theme.space.space{N}` | `theme.space.space16` |
| Gap | `theme.space.space{N}` | `theme.space.space8` |
| Border radius | `theme.radius.radius{N}` | `theme.radius.radius8` |
| Shadow | `theme.shadow.{name}` | `theme.shadow.shadow2` |
| Typography | `theme.typography.shared.{device}.{type}` | `theme.typography.shared.tablet.bodyM` |

**Note**: Use Storybook MCP or Grep (`src/web/src`) to discover all available token values. Don't memorize exhaustive lists.

## Error Recovery

If you realize you used hardcoded values:

1. Immediately stop
2. List all violations
3. Fix ALL violations before proceeding
4. Re-verify using audit checklist

## Summary: The Non-Negotiables

1. ✅ Always check MCP availability BEFORE starting
2. ✅ Call `mcp__storybook__get-ui-building-instructions` FIRST
3. ✅ Use `theme.*` tokens for ALL styling values
4. ✅ Import components from `@apify/ui-library`
5. ✅ Follow existing component patterns (read 1-3 examples)
6. ✅ Use semantic color naming (category.property)
7. ✅ Verify zero hardcoded values before submitting
8. ❌ NEVER hardcode colors (#hex or rgb)
9. ❌ NEVER hardcode spacing (Npx values)
10. ❌ NEVER create duplicate components

---

**Enforcement**: Any UI code not following these rules must be rejected and refactored immediately.
