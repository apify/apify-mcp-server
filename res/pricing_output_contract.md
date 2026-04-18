---
name: Pricing output contract
description: Contract for `pricingInfoToStructured` and `pricingInfoToString` — what `fetch-actor-details` and `search-actors` return.
---

# Pricing output contract

Contract for `pricingInfoToStructured` and `pricingInfoToString` in `src/utils/pricing_info.ts`.

## Goal

Keep the contract stable. This branch diverged; realign it to:

- `fetch-actor-details` → **complete** pricing, same as master.
- `search-actors` → **simplified** pricing, same shape as master but `tieredPricing` filtered to the user's tier. Unknown/missing tier → fall back to `FREE`.

**Structured data shape is identical in both modes.** Every field that appears in complete mode appears in simplified mode. The differences in simplified mode:

- `tieredPricing` arrays contain exactly one entry (the resolved tier).
- `PAY_PER_EVENT` events that were filtered from a tiered map also carry top-level `priceUsd` = resolved tier's price. Widget clients that skip the FREE tier in `tieredPricing` (see `src/web/src/utils/formatting.ts`) need this as a fallback so FREE-tier users see a concrete price instead of a generic "Pay per event" string.
- Top-level `pricingNote` is set only when the Actor has **multiple tiers** *and* they resolve consistently. Single-tier Actors don't get a note (the "higher tiers may offer lower prices" promise is vacuous).
- For `PAY_PER_EVENT` only: when `events.length > 5`, event `description` is omitted from simplified output and top-level `eventDescriptionsOmitted` / `eventDescriptionsNote` are set.

Both modes include top-level `userTier` (the user's plan tier).

`isFree` is not part of the output — consumers derive it from `model === 'FREE'`.

## Two modes

| Caller | Mode | `forTier` arg | `tieredPricing` array | `pricingNote` |
|---|---|---|---|---|
| `fetch-actor-details` | **complete** | always provided | full matrix, all tiers | absent |
| `search-actors` | **simplified** | always provided | one entry — the resolved tier | present when the resolved tier is consistent across the Actor |

## Rules

1. Complete mode preserves the **full tiered matrix** from master (no tier data lost) and adds `userTier`. The **text** representation is reformatted from master for consistency with simplified mode — see *Text output notes* below.
2. Simplified mode has the same field shape as complete mode; `tieredPricing` arrays are filtered to a single entry. Top-level `pricingNote` is added when the resolved tier is consistent across the Actor.
3. Tier resolution (simplified mode only): (a) `forTier` match in the actor's map, (b) `FREE` fallback, (c) first entry.
4. `userTier` is always the user's plan tier (the `forTier` value), even if we had to fall back to a different tier for prices in simplified mode.
5. `pricingNote` appears in simplified mode only when the Actor has **multiple tiers** (for `PRICE_PER_DATASET_ITEM` / `FLAT_PRICE_PER_MONTH`: `tieredPricing` has more than one entry; for `PAY_PER_EVENT`: at least one event's tiered map has more than one entry) **and** tiers resolve consistently across the Actor. It names the **resolved** tier (not `userTier`, if they differ). Single-tier Actors never get a note.
6. `pricingNote` is **omitted** in simplified mode when PAY_PER_EVENT events resolve to different tiers (e.g. event A offers GOLD, event B only offers FREE — no single actor-level label is truthful). Per-event `tieredPricing` arrays are still filtered correctly.
7. Simplified `PAY_PER_EVENT` keeps event descriptions when `events.length <= 5`.
8. Simplified `PAY_PER_EVENT` omits event descriptions when `events.length > 5`, keeps title + price, and sets:
   - `eventDescriptionsOmitted: true`
   - `eventDescriptionsNote: "Event descriptions were omitted because this actor has many pricing events. Use fetch-actor-details for full pricing details."`
9. Single-tier actors (raw data already has only one tier) produce the same `tieredPricing` output in both modes — a 1-element array.
10. `trialMinutes` is shown in both modes for `FLAT_PRICE_PER_MONTH`.
11. `FREE` actors (`pricingModel === 'FREE'` or null input) return `{ "model": "FREE", "userTier": "<tier>" }` in both modes.

## `pricingNote` wording

```
Prices shown are for <TIER> tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.
```

`<TIER>` ∈ `FREE`, `BRONZE`, `SILVER`, `GOLD`, `PLATINUM`, `DIAMOND` — the **resolved** tier.

---

## Examples

Using `compass/crawler-google-places` pricing (`PAY_PER_EVENT`). User on `GOLD` in all examples unless noted.

### E1. `fetch-actor-details` — complete mode

**Structured:**
```json
{
  "model": "PAY_PER_EVENT",
  "userTier": "GOLD",
  "events": [
    {
      "title": "Scraped place", "description": "...",
      "tieredPricing": [
        { "tier": "FREE", "priceUsd": 0.004 },
        { "tier": "BRONZE", "priceUsd": 0.004 },
        { "tier": "SILVER", "priceUsd": 0.003 },
        { "tier": "GOLD", "priceUsd": 0.0021 },
        { "tier": "PLATINUM", "priceUsd": 0.00126 },
        { "tier": "DIAMOND", "priceUsd": 0.00076 }
      ]
    },
    { "title": "Actor start", "description": "...", "priceUsd": 0.00005 }
  ]
}
```

**Text:**
```
This Actor is paid per event:
  - **Scraped place**: ... (FREE: $0.004, BRONZE: $0.004, SILVER: $0.003, GOLD: $0.0021, PLATINUM: $0.00126, DIAMOND: $0.00076 per event)
  - **Actor start**: ... ($0.00005 per event)
```

### E2. `search-actors`, user on GOLD

**Structured:** same shape as E1, `tieredPricing` filtered, `pricingNote` added. Simplified mode also mirrors the resolved price into top-level `priceUsd` on tiered events so the widget can render it for FREE-tier users (the widget's tier list skips FREE and falls back to `priceUsd`).
```json
{
  "model": "PAY_PER_EVENT",
  "userTier": "GOLD",
  "events": [
    {
      "title": "Scraped place", "description": "...",
      "priceUsd": 0.0021,
      "tieredPricing": [{ "tier": "GOLD", "priceUsd": 0.0021 }]
    },
    { "title": "Actor start", "description": "...", "priceUsd": 0.00005 }
  ],
  "pricingNote": "Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table."
}
```

**Text:**
```
This Actor is paid per event:
  - **Scraped place**: ... ($0.0021 per event)
  - **Actor start**: ... ($0.00005 per event)
Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.
```

### E3. `search-actors`, user on DIAMOND but actor doesn't offer DIAMOND → fall back to FREE

**Structured:** `userTier` is still `DIAMOND` (the user's plan). `tieredPricing` uses the FREE fallback. `pricingNote` names FREE (the **resolved** tier). Top-level `priceUsd` mirrors the resolved price (widget fallback).
```json
{
  "model": "PAY_PER_EVENT",
  "userTier": "DIAMOND",
  "events": [
    {
      "title": "Scraped place", "description": "...",
      "priceUsd": 0.004,
      "tieredPricing": [{ "tier": "FREE", "priceUsd": 0.004 }]
    },
    { "title": "Actor start", "description": "...", "priceUsd": 0.00005 }
  ],
  "pricingNote": "Prices shown are for FREE tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table."
}
```

### E4. Single-tier actor (only FREE bucket defined)

**Complete mode** (fetch-actor-details) — `tieredPricing` is preserved as a 1-element array, no `pricingNote`:
```json
{
  "model": "PAY_PER_EVENT",
  "userTier": "GOLD",
  "events": [
    {
      "title": "Scraped place", "description": "...",
      "tieredPricing": [{ "tier": "FREE", "priceUsd": 0.004 }]
    }
  ]
}
```

**Simplified mode** (search-actors) — same shape plus `priceUsd` for widget fallback. **No `pricingNote`** because the Actor has only one tier:
```json
{
  "model": "PAY_PER_EVENT",
  "userTier": "GOLD",
  "events": [
    {
      "title": "Scraped place", "description": "...",
      "priceUsd": 0.004,
      "tieredPricing": [{ "tier": "FREE", "priceUsd": 0.004 }]
    }
  ]
}
```

**Text (both modes, identical):**
```
This Actor is paid per event:
  - **Scraped place**: ... ($0.004 per event)
```

### E5. `PRICE_PER_DATASET_ITEM`, `fetch-actor-details`

**Structured:**
```json
{
  "model": "PRICE_PER_DATASET_ITEM",
  "userTier": "GOLD",
  "pricePerUnit": 0.005,
  "unitName": "result",
  "tieredPricing": [
    { "tier": "FREE", "pricePerUnit": 0.005 },
    { "tier": "BRONZE", "pricePerUnit": 0.004 },
    { "tier": "GOLD", "pricePerUnit": 0.002 }
  ]
}
```

**Text:**
```
This Actor has tiered pricing per 1000 results: FREE: $5, BRONZE: $4, GOLD: $2.
```

### E6. `PRICE_PER_DATASET_ITEM`, `search-actors`, user on GOLD

**Structured:**
```json
{
  "model": "PRICE_PER_DATASET_ITEM",
  "userTier": "GOLD",
  "pricePerUnit": 0.002,
  "unitName": "result",
  "tieredPricing": [{ "tier": "GOLD", "pricePerUnit": 0.002 }],
  "pricingNote": "Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table."
}
```

**Text:**
```
This Actor costs $2 per 1000 results. Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.
```

### E7. `FLAT_PRICE_PER_MONTH`, `search-actors`, user on GOLD

**Structured:**
```json
{
  "model": "FLAT_PRICE_PER_MONTH",
  "userTier": "GOLD",
  "pricePerUnit": 20,
  "trialMinutes": 10080,
  "tieredPricing": [{ "tier": "GOLD", "pricePerUnit": 20 }],
  "pricingNote": "Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table."
}
```

**Text:**
```
This Actor is rental and costs $20 per month, with a trial period of 7 days. Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.
```

### E8. FREE actor

**Structured (both modes):**
```json
{ "model": "FREE", "userTier": "GOLD" }
```

**Text (both modes):**
```
This Actor is free to use. You are only charged for Apify platform usage.
```

---

## Text output notes

- Prices render as `$<n>` — no trailing `USD`, no forced decimals, no thousands separator (`1000`, not `1,000`).
- Complete mode with multi-tier: tiers listed inline, comma-separated.
- Simplified mode: single price per event/unit, no tier labels inline. `pricingNote` is appended on its own line whenever the resolved tier is consistent across the Actor (including single-tier Actors).
- Simplified `PAY_PER_EVENT` with more than 5 events: omit event descriptions in both structured output and text, then append `eventDescriptionsNote` on its own line in text output.

### Intentional text divergence from master

The text representation in complete mode is **reformatted** from master. The structured data is lossless (full tier matrix preserved), but the human-readable text is tightened for consistency with simplified mode:

- `PAY_PER_EVENT` preamble: `"This Actor is paid per event:"` (master had `"This Actor is paid per event. You are not charged for the Apify platform usage, but only a fixed price for the following events:"`).
- Single-tier events drop the `(Tiered pricing: ...)` wrapper and render as flat `($X per event)`.
- `PRICE_PER_DATASET_ITEM` drops the `(in this case named X)` custom-unit-name phrasing; unit name appears directly in the sentence (`"per 1000 pages"` vs `"per 1000 results (in this case named pages)"`).
- `FLAT_PRICE_PER_MONTH` renders as `"costs $X per month"` instead of `"has a flat price of X USD per month"`.

Rationale: older phrasings read as boilerplate to LLMs and consume tokens without adding information the structured fields don't already carry. If you need the master phrasing verbatim, read the structured data and format it yourself.
