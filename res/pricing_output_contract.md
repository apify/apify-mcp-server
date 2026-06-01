---
name: Pricing output contract
description: Worked examples for the pricing output of `fetch-actor-details` (complete) and `search-actors` (simplified).
---

# Pricing output contract

The full rules live in the module docstring and implementation of
`src/utils/pricing_info.ts` (`pricingInfoToString`, `pricingInfoToStructured`,
`pricingInfoToSimplifiedString`, `pricingInfoToSimplifiedStructured`). **That code is the
source of truth.** This file keeps the worked examples as a test oracle, since they aren't
in code.

## Two modes (summary)

| Caller | Mode | `tieredPricing` array | `pricingNote` |
|---|---|---|---|
| `fetch-actor-details` | **complete** | full matrix, all tiers | absent |
| `search-actors` | **simplified** | one entry — the resolved tier | present only when the Actor has multiple tiers *and* they resolve consistently |

Both modes share the same field shape and include top-level `userTier` (the user's plan
tier). Simplified-mode tier resolution: (a) `forTier` match, (b) `FREE` fallback, (c) first
entry. `PAY_PER_EVENT` simplified output mirrors the resolved price into top-level
`priceUsd` (widget fallback for FREE-tier users) and omits event `description` when
`events.length > 5`. FREE actors return `{ "model": "FREE", "userTier": "<tier>" }`.

`pricingNote` wording:

```
Prices shown are for <TIER> tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.
```

`<TIER>` is the **resolved** tier ∈ `FREE`, `BRONZE`, `SILVER`, `GOLD`, `PLATINUM`, `DIAMOND`.

## Worked examples

Using `compass/crawler-google-places` pricing (`PAY_PER_EVENT`). User on `GOLD` unless noted.

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

**Structured:** same shape as E1, `tieredPricing` filtered, `pricingNote` added, resolved price mirrored into top-level `priceUsd` on tiered events (widget fallback).
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

**Structured:** `userTier` stays `DIAMOND` (the user's plan); `tieredPricing` uses the FREE fallback; `pricingNote` names FREE (the **resolved** tier).
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

**Complete mode** — 1-element `tieredPricing`, no `pricingNote`:
```json
{
  "model": "PAY_PER_EVENT",
  "userTier": "GOLD",
  "events": [
    { "title": "Scraped place", "description": "...", "tieredPricing": [{ "tier": "FREE", "priceUsd": 0.004 }] }
  ]
}
```

**Simplified mode** — same shape plus `priceUsd` fallback. **No `pricingNote`** (single tier):
```json
{
  "model": "PAY_PER_EVENT",
  "userTier": "GOLD",
  "events": [
    { "title": "Scraped place", "description": "...", "priceUsd": 0.004, "tieredPricing": [{ "tier": "FREE", "priceUsd": 0.004 }] }
  ]
}
```

**Text (both modes, identical):**
```
This Actor is paid per event:
  - **Scraped place**: ... ($0.004 per event)
```

### E5. `PRICE_PER_DATASET_ITEM`, `fetch-actor-details`

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
**Text:** `This Actor has tiered pricing per 1000 results: FREE: $5, BRONZE: $4, GOLD: $2.`

### E6. `PRICE_PER_DATASET_ITEM`, `search-actors`, user on GOLD

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
**Text:** `This Actor costs $2 per 1000 results. Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.`

### E7. `FLAT_PRICE_PER_MONTH`, `search-actors`, user on GOLD

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
**Text:** `This Actor is rental and costs $20 per month, with a trial period of 7 days. Prices shown are for GOLD tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.`

### E8. FREE actor

```json
{ "model": "FREE", "userTier": "GOLD" }
```
**Text:** `This Actor is free to use. You are only charged for Apify platform usage.`

## Text formatting notes

- Prices render as `$<n>` — no `USD` suffix, no forced decimals, no thousands separator (`1000`, not `1,000`).
- Complete multi-tier: tiers listed inline, comma-separated. Simplified: single price, no inline tier labels; `pricingNote` appended on its own line when the resolved tier is consistent.
- The complete-mode text is intentionally tightened from the older master phrasing (boilerplate preambles dropped) — the structured data stays lossless, so read that and format yourself if you need exact legacy wording.
