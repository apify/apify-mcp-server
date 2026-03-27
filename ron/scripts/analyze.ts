/**
 * PATTERN ANALYZER
 * Reads scraped JSON data and outputs:
 * - What content types perform best
 * - Which caption patterns hit vs flop
 * - Top audios by platform
 * - Content recommendations ranked by data
 *
 * Usage (after running scrapers):
 *   npx tsx ron/scripts/analyze.ts
 *
 * Or with live data:
 *   APIFY_TOKEN=your_token npx tsx ron/scripts/analyze.ts --live
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(import.meta.dirname, '../data');

interface Post {
    handle: string;
    platform: string;
    id: unknown;
    caption: string | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    audio: string | null;
    timestamp: unknown;
    url: unknown;
    hashtags: unknown;
    notes?: string;
}

interface PatternResult {
    pattern: string;
    avgViews: number;
    count: number;
    examples: string[];
    verdict: 'SCALE' | 'TEST' | 'KILL';
}

// Ron's known performance data (from manual input + brief)
// Used when no scraped data is available yet
const RON_KNOWN_DATA: Post[] = [
    {
        handle: 'yta.ron',
        platform: 'instagram',
        id: '1',
        caption: 'thanks mcdonalds for this',
        views: 3000000,
        likes: null,
        comments: null,
        shares: null,
        audio: 'trending',
        timestamp: '2024',
        url: null,
        hashtags: [],
    },
    {
        handle: 'yta.ron',
        platform: 'tiktok',
        id: '2',
        caption: '2016 canada larp',
        views: 248000,
        likes: null,
        comments: null,
        shares: null,
        audio: 'nostalgia audio',
        timestamp: '2025',
        url: null,
        hashtags: [],
    },
    {
        handle: 'yta.ron',
        platform: 'instagram',
        id: '3',
        caption: 'when every choice you make is deciding your fate...',
        views: 1000,
        likes: null,
        comments: null,
        shares: null,
        audio: 'ambient',
        timestamp: '2025',
        url: null,
        hashtags: [],
    },
    {
        handle: 'yta.ron',
        platform: 'instagram',
        id: '4',
        caption: 'whole time i thought this was temporary',
        views: 1000,
        likes: null,
        comments: null,
        shares: null,
        audio: 'ambient',
        timestamp: '2025',
        url: null,
        hashtags: [],
    },
    {
        handle: 'yta.ron',
        platform: 'instagram',
        id: '5',
        caption: 'trial reel (motivational car)',
        views: 1000,
        likes: null,
        comments: null,
        shares: null,
        audio: null,
        timestamp: '2025',
        url: null,
        hashtags: [],
    },
];

function classifyCaption(caption: string | null): string {
    if (!caption) return 'no-caption';
    const c = caption.toLowerCase();

    if (c.includes('thanks') && (c.includes('for this') || c.includes('for the'))) return 'ironic-credit';
    if (c.includes('2016') || c.includes('2000s') || c.includes('nostalgia') || c.includes("wouldn't believe")) return 'nostalgia-bait';
    if (c.includes('pov') || c.includes('when they') || c.includes('when ur')) return 'pov-format';
    if (c.includes('mysterious') || c.includes('jobless') || c.includes('unemployed') || c.includes('source of income')) return 'confusing-status';
    if (c.includes('if i dont') || c.includes('i sleep') || c.includes('bro')) return 'self-aware-chaos';
    if (c.includes('yta') || c.includes('method') || c.includes('analytics') || c.includes('views')) return 'info-yta';
    if (c.includes('fate') || c.includes('temporary') || c.includes('journey') || c.includes('every choice')) return 'deep-motivational';
    if (c.includes('trial') || c.includes('test')) return 'trial';
    if (c.includes('most people') || c.includes('they') || c.includes('everyone')) return 'ragebait-general';
    if (c.includes('anime') || c.includes('jjk') || c.includes('vagabond') || c.includes('naruto')) return 'anime-culture';
    if (c.includes('car') || c.includes('m4') || c.includes('bmw')) return 'car-flex';
    return 'other';
}

function getVerdict(avgViews: number, count: number): 'SCALE' | 'TEST' | 'KILL' {
    if (avgViews >= 100000) return 'SCALE';
    if (avgViews >= 10000 || count < 2) return 'TEST';
    return 'KILL';
}

function analyzePatterns(posts: Post[]): PatternResult[] {
    const byPattern: Record<string, Post[]> = {};

    for (const post of posts) {
        const pattern = classifyCaption(post.caption);
        if (!byPattern[pattern]) byPattern[pattern] = [];
        byPattern[pattern].push(post);
    }

    const results: PatternResult[] = [];

    for (const [pattern, patternPosts] of Object.entries(byPattern)) {
        const withViews = patternPosts.filter((p) => p.views !== null);
        if (withViews.length === 0) continue;

        const avgViews = withViews.reduce((sum, p) => sum + (p.views ?? 0), 0) / withViews.length;
        const examples = patternPosts
            .filter((p) => p.caption)
            .slice(0, 3)
            .map((p) => `"${p.caption?.slice(0, 60)}..."` );

        results.push({
            pattern,
            avgViews: Math.round(avgViews),
            count: patternPosts.length,
            examples,
            verdict: getVerdict(avgViews, patternPosts.length),
        });
    }

    return results.sort((a, b) => b.avgViews - a.avgViews);
}

function analyzeAudios(posts: Post[]): Array<{ audio: string; avgViews: number; count: number }> {
    const byAudio: Record<string, Post[]> = {};

    for (const post of posts) {
        if (!post.audio) continue;
        const key = post.audio.toLowerCase().slice(0, 50);
        if (!byAudio[key]) byAudio[key] = [];
        byAudio[key].push(post);
    }

    return Object.entries(byAudio)
        .map(([audio, audioPosts]) => {
            const withViews = audioPosts.filter((p) => p.views !== null);
            const avgViews =
                withViews.length > 0
                    ? withViews.reduce((sum, p) => sum + (p.views ?? 0), 0) / withViews.length
                    : 0;
            return { audio, avgViews: Math.round(avgViews), count: audioPosts.length };
        })
        .sort((a, b) => b.avgViews - a.avgViews)
        .slice(0, 20);
}

function loadScrapedData(): Post[] {
    const files = [
        join(DATA_DIR, 'ron-instagram.json'),
        join(DATA_DIR, 'ron-tiktok.json'),
        join(DATA_DIR, 'competitors-all.json'),
    ];

    const allPosts: Post[] = [];
    for (const file of files) {
        if (existsSync(file)) {
            const data = JSON.parse(readFileSync(file, 'utf-8')) as Post[];
            allPosts.push(...data);
        }
    }

    return allPosts;
}

function printReport(
    patterns: PatternResult[],
    audios: Array<{ audio: string; avgViews: number; count: number }>,
    totalPosts: number,
    dataSource: string,
): void {
    console.log('\n');
    console.log('═══════════════════════════════════════════════════');
    console.log('  RON CONTENT ANALYSIS REPORT');
    console.log(`  Data: ${dataSource} | Posts analyzed: ${totalPosts}`);
    console.log('═══════════════════════════════════════════════════\n');

    console.log('📊 CAPTION PATTERN PERFORMANCE\n');
    console.log('Pattern'.padEnd(25) + 'Avg Views'.padEnd(15) + 'Count'.padEnd(10) + 'Verdict');
    console.log('─'.repeat(65));

    for (const r of patterns) {
        const verdict = r.verdict === 'SCALE' ? '🟢 SCALE' : r.verdict === 'TEST' ? '🟡 TEST' : '🔴 KILL';
        console.log(
            r.pattern.padEnd(25) +
                r.avgViews.toLocaleString().padEnd(15) +
                r.count.toString().padEnd(10) +
                verdict,
        );
        if (r.examples.length > 0) {
            console.log(`  └─ e.g. ${r.examples[0]}`);
        }
    }

    console.log('\n');
    console.log('🎵 TOP AUDIOS BY PERFORMANCE\n');
    for (const a of audios.slice(0, 10)) {
        console.log(`  ${a.audio.slice(0, 40).padEnd(42)} avg ${a.avgViews.toLocaleString()} views (${a.count} posts)`);
    }

    console.log('\n');
    console.log('💡 RECOMMENDATIONS FOR RON\n');

    const scalePatterns = patterns.filter((p) => p.verdict === 'SCALE');
    const killPatterns = patterns.filter((p) => p.verdict === 'KILL');

    if (scalePatterns.length > 0) {
        console.log('  POST MORE OF:');
        for (const p of scalePatterns) {
            console.log(`    ✅ ${p.pattern} — avg ${p.avgViews.toLocaleString()} views`);
        }
    }

    if (killPatterns.length > 0) {
        console.log('\n  STOP POSTING:');
        for (const p of killPatterns) {
            console.log(`    ❌ ${p.pattern} — avg ${p.avgViews.toLocaleString()} views`);
        }
    }
}

function main(): void {
    console.log('🔍 RON PATTERN ANALYZER');
    console.log('========================');

    let posts = loadScrapedData();
    let dataSource: string;

    if (posts.length === 0) {
        console.log('  ⚠️  No scraped data found. Using known performance data.');
        console.log('  Run scrape-ron.ts and scrape-competitors.ts first for full analysis.\n');
        posts = RON_KNOWN_DATA;
        dataSource = 'manual (run scrapers for full data)';
    } else {
        console.log(`  ✅ Loaded ${posts.length} posts from scraped data`);
        dataSource = 'scraped';
    }

    const ronPosts = posts.filter((p) => p.handle === 'yta.ron');
    const competitorPosts = posts.filter((p) => p.handle !== 'yta.ron');

    console.log(`  📊 Ron: ${ronPosts.length} posts | Competitors: ${competitorPosts.length} posts`);

    // Ron's own patterns
    console.log('\n─── RON\'s OWN CONTENT ───');
    const ronPatterns = analyzePatterns(ronPosts);
    const ronAudios = analyzeAudios(ronPosts);
    printReport(ronPatterns, ronAudios, ronPosts.length, dataSource);

    // Competitor patterns (what works for them)
    if (competitorPosts.length > 0) {
        console.log('\n─── COMPETITOR PATTERNS ───');
        const compPatterns = analyzePatterns(competitorPosts);
        const compAudios = analyzeAudios(competitorPosts);
        printReport(compPatterns, compAudios, competitorPosts.length, 'scraped');
    }

    // Save report
    const report = {
        generatedAt: new Date().toISOString(),
        ronPatterns: analyzePatterns(ronPosts),
        competitorPatterns: competitorPosts.length > 0 ? analyzePatterns(competitorPosts) : [],
        topAudiosRon: analyzeAudios(ronPosts),
        topAudiosCompetitors: competitorPosts.length > 0 ? analyzeAudios(competitorPosts) : [],
    };

    const reportPath = join(DATA_DIR, '../analysis-report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📁 Full report saved to ron/analysis-report.json`);
}

main();
