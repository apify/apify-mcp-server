# RON OPERATIONS

AI-backed COO system for @yta.ron brand.

## Files

| File | Purpose |
|------|---------|
| `BRAND_BIBLE.md` | Full brand strategy, content pillars, creator analysis, rules |
| `CONTENT_CALENDAR.md` | 2-week content calendar with real captions + 30-day backlog |
| `scripts/scrape-ron.ts` | Scrapes @yta.ron Instagram + TikTok posts |
| `scripts/scrape-competitors.ts` | Scrapes all reference creators (8ball, Aldo, Brezscale, TJR, Sam Zia, etc.) |
| `scripts/analyze.ts` | Pattern analysis — what hits vs flops, top audios, recommendations |
| `data/` | Scraped JSON data (gitignored) |
| `analysis-report.json` | Latest analysis output |

## Setup

```bash
# Add your Apify token (get it from apify.com → Settings → Integrations → API tokens)
export APIFY_TOKEN=your_apify_token_here
```

## Run

```bash
# 1. Scrape Ron's own content
npx tsx ron/scripts/scrape-ron.ts

# 2. Scrape competitors
npx tsx ron/scripts/scrape-competitors.ts

# 3. Analyze patterns (works with or without scraped data)
npx tsx ron/scripts/analyze.ts
```

## Workflow

Run scrapers weekly. Check analysis report. Update content calendar based on what's hitting.
