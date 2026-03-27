/**
 * COMPETITOR SCRAPER
 * Scrapes all reference creators from Ron's inspiration list.
 *
 * Usage:
 *   APIFY_TOKEN=your_token npx tsx ron/scripts/scrape-competitors.ts
 */

import { ApifyClient } from 'apify-client';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) throw new Error('APIFY_TOKEN env var required');

const client = new ApifyClient({ token: TOKEN });
const OUTPUT_DIR = join(import.meta.dirname, '../data/competitors');
mkdirSync(OUTPUT_DIR, { recursive: true });

interface CreatorConfig {
    handle: string;
    platform: 'instagram' | 'tiktok';
    url: string;
    notes: string;
}

const COMPETITORS: CreatorConfig[] = [
    // Main inspirations
    {
        handle: '8ball',
        platform: 'instagram',
        url: 'https://www.instagram.com/8ball/',
        notes: 'Trendy captions + audios, internet culture, easy to spam',
    },
    {
        handle: 'aldo',
        platform: 'instagram',
        url: 'https://www.instagram.com/aldo/',
        notes: 'Absurd comedy skits, chaotic relatable, face on camera',
    },
    {
        handle: 'brezscale',
        platform: 'instagram',
        url: 'https://www.instagram.com/brezscale/',
        notes: 'Quiet confidence car content, static shots, ambient audio',
    },
    {
        handle: 'tjr',
        platform: 'instagram',
        url: 'https://www.instagram.com/tjr/',
        notes: 'Trading lifestyle + education, professional photoshoots, 2M followers',
    },
    {
        handle: 'samzia',
        platform: 'instagram',
        url: 'https://www.instagram.com/samzia/',
        notes: 'Online biz vlogs, transparent journey, evolved brand beyond niche',
    },
    {
        handle: 'ecomfed',
        platform: 'instagram',
        url: 'https://www.instagram.com/ecomfed/',
        notes: 'Basic materialistic reels + motivational captions, 2 creators',
    },
    {
        handle: 'adav1a',
        platform: 'instagram',
        url: 'https://www.instagram.com/adav1a/',
        notes: 'TJR clone but YTA-based, higher quality AE edits',
    },
    // TikTok equivalents
    {
        handle: 'yta.ron_tt',
        platform: 'tiktok',
        url: 'https://www.tiktok.com/@8ball',
        notes: '8ball TikTok presence',
    },
    {
        handle: 'parannoyed',
        platform: 'tiktok',
        url: 'https://www.tiktok.com/@parannoyed_',
        notes: 'Photo collage + relatable rant text, 2000s edits',
    },
];

interface ScrapedPost {
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
    notes: string;
}

async function scrapeInstagramCreator(creator: CreatorConfig): Promise<ScrapedPost[]> {
    console.log(`  📸 Instagram @${creator.handle}...`);

    try {
        const run = await client.actor('apify/instagram-scraper').call({
            directUrls: [creator.url],
            resultsType: 'posts',
            resultsLimit: 30,
            addParentData: false,
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 30 });

        return items.map((p: Record<string, unknown>) => {
            const musicInfo = p.musicInfo as Record<string, unknown> | null;
            return {
                handle: creator.handle,
                platform: 'instagram',
                id: p.id,
                caption: (p.caption as string) || null,
                views: (p.videoViewCount as number) || (p.videoPlayCount as number) || null,
                likes: (p.likesCount as number) || null,
                comments: (p.commentsCount as number) || null,
                shares: null,
                audio: musicInfo ? `${musicInfo.artistName} - ${musicInfo.songName}` : null,
                timestamp: p.timestamp,
                url: p.url,
                hashtags: p.hashtags,
                notes: creator.notes,
            };
        });
    } catch (err) {
        console.error(`    ❌ Failed ${creator.handle}:`, (err as Error).message);
        return [];
    }
}

async function scrapeTikTokCreator(creator: CreatorConfig): Promise<ScrapedPost[]> {
    console.log(`  🎵 TikTok @${creator.handle}...`);

    try {
        const run = await client.actor('clockworks/tiktok-scraper').call({
            profiles: [creator.url],
            resultsPerPage: 30,
            shouldDownloadCovers: false,
            shouldDownloadVideos: false,
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 30 });

        return items.map((v: Record<string, unknown>) => {
            const musicMeta = v.musicMeta as Record<string, unknown> | null;
            return {
                handle: creator.handle,
                platform: 'tiktok',
                id: v.id,
                caption: (v.text as string) || null,
                views: (v.playCount as number) || null,
                likes: (v.diggCount as number) || null,
                comments: (v.commentCount as number) || null,
                shares: (v.shareCount as number) || null,
                audio: musicMeta ? `${musicMeta.musicAuthor} - ${musicMeta.musicName}` : null,
                timestamp: v.createTime,
                url: v.webVideoUrl,
                hashtags: v.hashtags,
                notes: creator.notes,
            };
        });
    } catch (err) {
        console.error(`    ❌ Failed ${creator.handle}:`, (err as Error).message);
        return [];
    }
}

async function main(): Promise<void> {
    console.log('🚀 COMPETITOR SCRAPER — Starting');
    console.log('=================================');

    const allPosts: ScrapedPost[] = [];

    for (const creator of COMPETITORS) {
        let posts: ScrapedPost[];
        if (creator.platform === 'instagram') {
            posts = await scrapeInstagramCreator(creator);
        } else {
            posts = await scrapeTikTokCreator(creator);
        }
        allPosts.push(...posts);

        // Save per-creator file
        const creatorPath = join(OUTPUT_DIR, `${creator.handle}-${creator.platform}.json`);
        writeFileSync(creatorPath, JSON.stringify(posts, null, 2));
        console.log(`    ✅ ${posts.length} posts saved`);
    }

    // Save combined file
    const combinedPath = join(OUTPUT_DIR, '../competitors-all.json');
    writeFileSync(combinedPath, JSON.stringify(allPosts, null, 2));
    console.log(`\n✅ Total: ${allPosts.length} posts across ${COMPETITORS.length} creators`);
    console.log(`   Saved to ron/data/`);
}

main().catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
