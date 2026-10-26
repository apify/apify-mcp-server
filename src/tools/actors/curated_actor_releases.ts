import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { CURATED_ACTOR_CONTRACT_VERSION } from './curated_actor_catalog.js';

const ReleaseReviewValidator = z.strictObject({
    contractVersion: z.literal(CURATED_ACTOR_CONTRACT_VERSION),
    reviewedBy: z.string().trim().min(1),
    reviewedAt: z.iso.datetime(),
    evidence: z.string().trim().min(1),
});

/** Approval is release configuration, never a model-callable argument or a publisher-name heuristic. */
export const CuratedActorReleaseValidator = z.strictObject({
    actorId: z.string().regex(/^[a-zA-Z0-9]{17}$/),
    buildId: z
        .string()
        .regex(/^[a-zA-Z0-9]{17}$/)
        .nullable(),
    buildNumber: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .nullable(),
    observedAt: z.iso.date(),
    maintenanceOwner: z.literal('Apify'),
    maintenanceEvidence: z.url(),
    sourceVisibility: z.enum(['hidden', 'visible', 'not-inspected']),
    review: ReleaseReviewValidator.nullable(),
});

export type CuratedActorRelease = z.infer<typeof CuratedActorReleaseValidator>;
export type CuratedActorReleases = Readonly<Record<string, CuratedActorRelease>>;

/**
 * Discovery snapshots only. None of these builds has release approval.
 * A maintainer must review the exact build, dependencies, data handling and mapped inputs,
 * record the evidence below, and rerun the release checks before enabling execution.
 * Source visibility alone never establishes approval, and a new build never inherits it.
 */
export const CURATED_ACTOR_RELEASES: CuratedActorReleases = {
    [HELPER_TOOLS.CHATGPT_WEB_SEARCH]: {
        actorId: 'yD95d01y3SlKrPqQ7',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/apify/web-search',
        buildId: 'IiPL53af0DNBgkFX8',
        buildNumber: '0.0.20',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_WEB_FETCH]: {
        actorId: 'a6Sqhlnt4touIHTub',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/apify/web-fetch',
        buildId: 'C1Yufsdmf7hffPfl9',
        buildNumber: '0.0.30',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_WEBSITE_CONTENT]: {
        actorId: 'aYG0l9s7dbB7j3gbS',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/apify/website-content-crawler',
        buildId: 'bsZdc9Cal4wAwV0VW',
        buildNumber: '0.3.101',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_SCREENSHOT]: {
        actorId: 'rGCyoaKTKhyMiiTvS',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/apify/screenshot-url',
        buildId: 'AEgoxMZIJXkz2zxdq',
        buildNumber: '0.0.66',
        observedAt: '2026-10-26',
        sourceVisibility: 'visible',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_SITEMAP]: {
        actorId: 'rGeTNESChDZ65EbYh',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/apify/sitemap-extractor',
        buildId: 'e16XISfdhxOWHF3Db',
        buildNumber: '0.1.30',
        observedAt: '2026-10-26',
        sourceVisibility: 'visible',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_GOOGLE_MAPS]: {
        actorId: 'nwua9Gu5YrADL7ZDj',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/compass/crawler-google-places',
        buildId: 'EH35UvIrsV0hnZG0Y',
        buildNumber: '0.14.775',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_AMAZON_PRODUCTS]: {
        actorId: 'BG3WDrGdteHgZgbPK',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/junglee/amazon-crawler',
        buildId: 'BrNBL93fpaDpXCmhA',
        buildNumber: '0.0.441',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_YOUTUBE]: {
        actorId: 'h7sDV53CddomktSi5',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/streamers/youtube-scraper',
        buildId: 'kOLogYtrERZU9YfGW',
        buildNumber: '0.0.319',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_TIKTOK]: {
        actorId: 'GdWCkxBtKWOsKjdch',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/clockworks/tiktok-scraper',
        buildId: 'O7b58rnGZYU3P0DX4',
        buildNumber: '0.0.620',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_INSTAGRAM]: {
        actorId: 'shu8hvrXbJbY3Eb9W',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/apify/instagram-scraper',
        buildId: 'vEteb4rbcDg3FSQY6',
        buildNumber: '0.0.830',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_FACEBOOK_POSTS]: {
        actorId: 'KoJrdxJCTtpon81KY',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/apify/facebook-posts-scraper',
        buildId: '4wMadXpcOrMwWYpSz',
        buildNumber: '0.0.404',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_BOOKING]: {
        actorId: 'oeiQgfg5fsmIJB7Cn',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/voyager/booking-scraper',
        buildId: 'UbddRwuHiMrBtTctB',
        buildNumber: '0.0.197',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
    [HELPER_TOOLS.CHATGPT_TRIPADVISOR]: {
        actorId: 'dbEyMBriog95Fv8CW',
        maintenanceOwner: 'Apify',
        maintenanceEvidence: 'https://apify.com/maxcopell/tripadvisor',
        buildId: 'UeIiKUOLTjcia9GlG',
        buildNumber: '0.0.294',
        observedAt: '2026-10-26',
        sourceVisibility: 'hidden',
        review: null,
    },
};
