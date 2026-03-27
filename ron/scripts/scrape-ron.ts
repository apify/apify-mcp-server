/**
 * RON SOCIAL MEDIA SCRAPER
 * Scrapes @yta.ron on Instagram and TikTok, saves results to JSON.
 *
 * Usage:
 *   APIFY_TOKEN=your_token npx tsx ron/scripts/scrape-ron.ts
 */

import { ApifyClient } from 'apify-client';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) throw new Error('APIFY_TOKEN env var required');

const client = new ApifyClient({ token: TOKEN });
const OUTPUT_DIR = join(import.meta.dirname, '../data');
mkdirSync(OUTPUT_DIR, { recursive: true });

const RON_IG = 'https://www.instagram.com/yta.ron/';
const RON_TT = 'https://www.tiktok.com/@yta.ron';

async function waitForRun(runId: string, actorId: string): Promise<string> {
    console.log(`  Waiting for run ${runId}...`);
    while (true) {
        const run = await client.actor(actorId).lastRun().get();
        if (!run) throw new Error('Run not found');
        if (run.status === 'SUCCEEDED') return run.defaultDatasetId;
        if (run.status === 'FAILED' || run.status === 'ABORTED') {
            throw new Error(`Run ${runId} ${run.status}`);
        }
        await new Promise((r) => setTimeout(r, 5000));
    }
}

async function scrapeInstagram(): Promise<void> {
    console.log('\n📸 Scraping Instagram @yta.ron...');

    const run = await client.actor('apify/instagram-scraper').call({
        directUrls: [RON_IG],
        resultsType: 'posts',
        resultsLimit: 50,
        addParentData: true,
    });

    const datasetId = run.defaultDatasetId;
    const { items } = await client.dataset(datasetId).listItems({ limit: 50 });

    const posts = items.map((p: Record<string, unknown>) => ({
        id: p.id,
        shortCode: p.shortCode,
        type: p.type,
        caption: p.caption,
        timestamp: p.timestamp,
        likesCount: p.likesCount,
        commentsCount: p.commentsCount,
        videoViewCount: p.videoViewCount,
        videoPlayCount: p.videoPlayCount,
        url: p.url,
        displayUrl: p.displayUrl,
        musicInfo: p.musicInfo,
        hashtags: p.hashtags,
        mentions: p.mentions,
        locationName: p.locationName,
    }));

    const outPath = join(OUTPUT_DIR, 'ron-instagram.json');
    writeFileSync(outPath, JSON.stringify(posts, null, 2));
    console.log(`  ✅ ${posts.length} posts saved to ${outPath}`);
}

async function scrapeTikTok(): Promise<void> {
    console.log('\n🎵 Scraping TikTok @yta.ron...');

    const run = await client.actor('clockworks/tiktok-scraper').call({
        profiles: [RON_TT],
        resultsPerPage: 50,
        shouldDownloadCovers: false,
        shouldDownloadVideos: false,
        shouldDownloadSubtitles: true,
    });

    const datasetId = run.defaultDatasetId;
    const { items } = await client.dataset(datasetId).listItems({ limit: 50 });

    const videos = items.map((v: Record<string, unknown>) => ({
        id: v.id,
        text: v.text,
        createTime: v.createTime,
        authorMeta: v.authorMeta,
        musicMeta: v.musicMeta,
        diggCount: v.diggCount,
        shareCount: v.shareCount,
        playCount: v.playCount,
        commentCount: v.commentCount,
        webVideoUrl: v.webVideoUrl,
        hashtags: v.hashtags,
        effectStickers: v.effectStickers,
        mentions: v.mentions,
    }));

    const outPath = join(OUTPUT_DIR, 'ron-tiktok.json');
    writeFileSync(outPath, JSON.stringify(videos, null, 2));
    console.log(`  ✅ ${videos.length} videos saved to ${outPath}`);
}

async function main(): Promise<void> {
    console.log('🚀 RON SCRAPER — Starting');
    console.log('================================');

    await scrapeInstagram();
    await scrapeTikTok();

    console.log('\n✅ Done. Data saved to ron/data/');
}

main().catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
