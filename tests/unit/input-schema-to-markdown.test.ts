/* eslint-disable max-len */
import { describe, expect, it } from 'vitest';

import { inputSchemaToMarkdown } from '../../src/utils/input-schema-to-markdown.js';

describe('inputSchemaToMarkdown', () => {
    it('should format schema for Actor apify/facebook-posts-scraper', () => {
        const schema = { title: 'Input schema for the empty project actor.',
            description: "This scraper will get post and page details from Facebook pages of your choice. To try it out, just paste a Facebook Page URL and click ▷ Start. If you need any guidance, just <a href='https://blog.apify.com/scrape-facebook-posts-data/' target='_blank' rel='noopener'>follow this tutorial</a>.",
            type: 'object',
            schemaVersion: 1,
            properties: {
                startUrls: {
                    title: 'Facebook URLs',
                    description: 'Enter a valid Facebook page URL, e.g. <code>https://www.facebook.com/humansofnewyork/</code>. Note that you can only scrape public pages with this Actor, not personal profiles.',
                    type: 'array',
                    prefill: [{ url: 'https://www.facebook.com/humansofnewyork/' }],
                },
                resultsLimit: {
                    title: 'Results amount',
                    description: 'If this limit is not set, only the initial page of results will be extracted.',
                    type: 'integer',
                    prefill: 20,
                },
                captionText: {
                    title: 'Include video transcript',
                    description: 'Extract video transcript (if available).',
                    type: 'boolean',
                    default: false,
                },
                onlyPostsNewerThan: {
                    title: 'Posts newer than',
                    description: "Scrape posts from the provided date to the present day (or date set in 'Older than'). The date should be in YYYY-MM-DD or full ISO absolute format or in relative format e.g. 1 days, 2 months, 3 years.",
                    type: 'string',
                },
                onlyPostsOlderThan: {
                    title: 'Posts older than',
                    description: "Scrape posts from the provided date to the past (or date set in 'Newer than'). The date should be in YYYY-MM-DD or full ISO absolute format or in relative format e.g. 1 days, 2 months, 3 years.",
                    type: 'string',
                },
            },
            required: ['startUrls'] };

        const result = inputSchemaToMarkdown(schema);
        expect(result).toMatchInlineSnapshot(`
          "# JSON Schema

          This scraper will get post and page details from Facebook pages of your choice. To try it out, just paste a Facebook Page URL and click ▷ Start. If you need any guidance, just <a href='https://blog.apify.com/scrape-facebook-posts-data/' target='_blank' rel='noopener'>follow this tutorial</a>.

          ## \`startUrls\` required array
          Enter a valid Facebook page URL, e.g. <code>https://www.facebook.com/humansofnewyork/</code>. Note that you can only scrape public pages with this Actor, not personal profiles.

          ## \`resultsLimit\` optional integer prefill:20
          If this limit is not set, only the initial page of results will be extracted.

          ## \`captionText\` optional boolean default:false
          Extract video transcript (if available).

          ## \`onlyPostsNewerThan\` optional string
          Scrape posts from the provided date to the present day (or date set in 'Older than'). The date should be in YYYY-MM-DD or full ISO absolute format or in relative format e.g. 1 days, 2 months, 3 years.

          ## \`onlyPostsOlderThan\` optional string
          Scrape posts from the provided date to the past (or date set in 'Newer than'). The date should be in YYYY-MM-DD or full ISO absolute format or in relative format e.g. 1 days, 2 months, 3 years."
        `);
    });

    it('should format schema for Actor compass/google-maps-extractor', () => {
        const schema = {
            title: 'Google Maps Data Scraper',
            type: 'object',
            description: 'To extract contact details from Google places, simply enter 🔍 <b>Search term</b>, add 📍 <b>Location</b>, and 💯 <b>Number of places</b> to extract. Section 🎯 <b>Filters</b> contains various extra features, filters, and sorting options. <br><br> Sections <b>with asterisk*</b> are just alternative ways to start the input (📡 Geolocation parameters, 🛰 Polygons, 🔗 URLs). They can be combined with any of the features and sorting options from the <b>Filters</b> section.',
            schemaVersion: 1,
            properties: {
                searchStringsArray: {
                    title: '🔍 Search terms',
                    description: "Type what you’d normally search for in the Google Maps search bar, like <b>English breakfast</b> or <b>pet shelter</b>. Aim for unique terms for faster processing. Using similar terms (e.g., <b>bar</b> vs. <b>restaurant</b> vs. <b>cafe</b>) may slightly increase your capture rate but is less efficient.<br><br> ⚠️ Heads up: Adding a location directly to the search, e.g., <b>restaurant Pittsburgh</b>, can limit you to a maximum of 120 results per search term due to <a href='https://blog.apify.com/...",
                    type: 'array',
                    prefill: [
                        'restaurant',
                    ],
                },
                locationQuery: {
                    title: '📍 Location (use only one location per run)',
                    description: "Define location using free text. Simpler formats work best; e.g., use City + Country rather than City + Country + State. Verify with the <a href='https://nominatim.openstreetmap.org/ui/search.html'>OpenStreetMap webapp</a> for visual validation of the exact area you want to cover. <br><br>⚠️ Automatically defined City polygons may be smaller than expected (e.g., they don't include agglomeration areas). If you need to define the whole city area, head over to the 📡 <b>Geolocation parameters*</b> ...",
                    type: 'string',
                    prefill: 'New York, USA',
                },
                maxCrawledPlacesPerSearch: {
                    title: '💯 Number of places to extract (per each search term or URL)',
                    description: 'Number of results you expect to get per each Search term, Category or URL. The higher the number, the longer it will take. <br><br>If you want to scrape all places available, <b>leave this field empty</b> or use this section <b>🧭 Scrape all places on the map*</b>.',
                    type: 'integer',
                    prefill: 50,
                },
                language: {
                    title: '🌍 Language',
                    description: 'Scraping results will show in this language.',
                    enum: ['en', 'af', 'az', 'id', 'ms', 'bs', 'ca', 'cs', 'da', 'de', 'et', 'es', 'es-419', 'eu', 'fil', 'fr', 'gl', 'hr', 'zu', 'is', 'it', 'sw', 'lv', 'lt', 'hu', 'nl', 'no', 'uz', 'pl', 'pt-BR', 'pt-PT', 'ro', 'sq', 'sk', 'sl', 'fi', 'sv', 'vi', 'tr', 'el', 'bg', 'ky', 'kk', 'mk', 'mn', 'ru', 'sr', 'uk', 'ka', 'hy', 'iw', 'ur', 'ar', 'fa', 'am', 'ne', 'hi', 'mr', 'bn', 'pa', 'gu', 'ta', 'te', 'kn', 'ml', 'si', 'th', 'lo', 'my', 'km', 'ko', 'ja', 'zh-CN', 'zh-TW'],
                    type: 'string',
                    default: 'en',
                    prefill: 'en',
                },
                categoryFilterWords: {
                    title: '🎢 Place categories',
                    description: "You can filter places by categories, which Google Maps has <a href='https://api.apify.com/v2/key-value-stores/epxZwNRgmnzzBpNJd/records/categories'>over 4,000</a>. Categories can be general, e.g. <b>beach</b>, which would include all places containing that word e.g. <b>black sand beach</b>, or specific, e.g. <b>beach club</b>. <br><br>⚠️ You can use <b>🎢 Place categories</b> alone or with <b>🔍 Search terms</b>. <b>🔍 Search terms</b> focus on searching, while <b>🎢 Categories</b> filter result...",
                    type: 'array',
                    items: {
                        type: 'string',
                        enum: ['abbey', 'accountant', 'accounting', 'acupuncturist', 'aeroclub', 'agriculture', 'airline', 'airport', 'airstrip', 'allergist', 'amphitheater', 'amphitheatre', 'anesthesiologist', 'appraiser', 'aquarium', 'arboretum', 'architect', 'archive', 'arena', 'artist', 'ashram', 'astrologer', 'atm'],
                    },
                },
                placeMinimumStars: {
                    title: 'Set a minimum star rating',
                    description: 'Scrape only places with a rating equal to or above the selected stars. Places without reviews will also be skipped. Keep in mind, filtering by reviews reduces the number of places found per credit spent, as many will be excluded.',
                    enum: ['', 'two', 'twoAndHalf', 'three', 'threeAndHalf', 'four', 'fourAndHalf'],
                    type: 'string',
                    default: '',
                },
                website: {
                    title: 'Scrape places with/without a website',
                    description: 'Use this to exclude places without a website, or vice versa. This option is turned off by default.',
                    enum: ['allPlaces', 'withWebsite', 'withoutWebsite'],
                    type: 'string',
                    default: 'allPlaces',
                },
                searchMatching: {
                    title: 'Get exact name matches (no similar results)',
                    description: 'Restrict what places are scraped based on matching their name with provided 🔍 <b>Search term</b>. E.g., all places that have <b>chicken</b> in their name vs. places called <b>Kentucky Fried Chicken</b>.',
                    enum: ['all', 'only_includes', 'only_exact'],
                    type: 'string',
                    default: 'all',
                },
                skipClosedPlaces: {
                    title: '⏩ Skip closed places',
                    description: 'Skip places that are marked as temporary or permanently closed. Ideal for focusing on currently open places.',
                    type: 'boolean',
                    default: false,
                },
                countryCode: {
                    title: '🗺 Country',
                    description: 'Set the country where the data extraction should be carried out, e.g., <b>United States</b>.',
                    enum: ['', 'us', 'af', 'al', 'dz', 'as', 'ad', 'ao', 'ai', 'aq', 'ag', 'ar', 'am', 'aw', 'au', 'at', 'az', 'bs', 'bh', 'bd', 'bb', 'by', 'be', 'bz', 'bj', 'bm', 'bt', 'bo', 'ba', 'bw', 'bv', 'br', 'io', 'bn', 'bg', 'bf', 'bi', 'kh', 'cm', 'ca', 'cv', 'ky', 'cf', 'td', 'cl', 'cn', 'cx', 'cc', 'co', 'km', 'cg', 'cd', 'ck', 'cr', 'ci', 'hr', 'cu', 'cy', 'cz', 'dk', 'dj', 'dm', 'do', 'ec', 'eg', 'sv', 'gq', 'er', 'ee', 'et', 'fk', 'fo', 'fj', 'fi', 'fr', 'gf', 'pf', 'tf', 'ga', 'gm', 'ge', 'de', 'gh', 'gi', 'gr', 'gl', 'gd', 'gp', 'gu', 'gt', 'gn', 'gw', 'gy', 'ht', 'hm', 'va', 'hn', 'hk', 'hu', 'is', 'in'],
                    type: 'string',
                },
                city: {
                    title: '🌇 City',
                    description: "Enter the city where the data extraction should be carried out, e.g., <b>Pittsburgh</b>.<br><br>⚠️ <b>Do not include State or Country names here.</b><br><br>⚠️ Automatic City polygons may be smaller than expected (e.g., they don't include agglomeration areas). If you need that, set up the location using Country, State, County, City, or Postal code.<br>For an even more precise location definition (, head over to <b>🛰 Custom search area</b> section to create polygon shapes of the areas you want t...",
                    type: 'string',
                },
                state: {
                    title: 'State',
                    description: 'Set a state where the data extraction should be carried out, e.g., <b>Massachusetts</b> (mainly for the US addresses).',
                    type: 'string',
                },
                county: {
                    title: 'county',
                    description: 'Set the county where the data extraction should be carried out.<br><br>⚠️ Note that <b>county</b> may represent different administrative areas in different countries: a county (e.g., US), regional district (e.g., Canada) or département (e.g., France).',
                    type: 'string',
                },
                postalCode: {
                    title: 'Postal code',
                    description: 'Set the postal code of the area where the data extraction should be carried out, e.g., <b>10001</b>. <br><br>⚠️ <b>Combine Postal code only with 🗺 Country, never with 🌇 City. You can only input one postal code at a time.</b>',
                    type: 'string',
                },
                customGeolocation: {
                    title: '🛰 Custom search area (coordinate order must be: [↕ longitude, ↔ latitude])',
                    description: "Use this field to define the exact search area if other search area parameters don't work for you. See <a href='https://apify.com/compass/crawler-google-places#custom-search-area' target='_blank' rel='noopener'>readme</a> or <a href='https://blog.apify.com/google-places-api-limits/#1-create-a-custom-area-by-using-pairs-of-coordinates-%F0%9F%93%A1' target='_blank' rel='noopener'>our guide</a> for details.",
                    type: 'object',
                },
                startUrls: {
                    title: 'Google Maps URLs',
                    description: 'Max 300 results per search URL. Valid format for URLs contains <code>google.com/maps/</code>. This feature also supports uncommon URL formats such as: <code>google.com?cid=***</code>, <code>goo.gl/maps</code>, and custom place list URL.',
                    type: 'array',
                },
            },
        };

        const result = inputSchemaToMarkdown(schema);
        expect(result).toMatchInlineSnapshot(`
          "# JSON Schema

          To extract contact details from Google places, simply enter 🔍 <b>Search term</b>, add 📍 <b>Location</b>, and 💯 <b>Number of places</b> to extract. Section 🎯 <b>Filters</b> contains various extra features, filters, and sorting options. <br><br> Sections <b>with asterisk*</b> are just alternative ways to start the input (📡 Geolocation parameters, 🛰 Polygons, 🔗 URLs). They can be combined with any of the features and sorting options from the <b>Filters</b> section.

          ## \`searchStringsArray\` optional array
          Type what you’d normally search for in the Google Maps search bar, like <b>English breakfast</b> or <b>pet shelter</b>. Aim for unique terms for faster processing. Using similar terms (e.g., <b>bar</b> vs. <b>restaurant</b> vs. <b>cafe</b>) may slightly increase your capture rate but is less efficient.<br><br> ⚠️ Heads up: Adding a location directly to the search, e.g., <b>restaurant Pittsburgh</b>, can limit you to a maximum of 120 results per search term due to <a href='https://blog.apify.com/...

          ## \`locationQuery\` optional string prefill:New York, USA
          Define location using free text. Simpler formats work best; e.g., use City + Country rather than City + Country + State. Verify with the <a href='https://nominatim.openstreetmap.org/ui/search.html'>OpenStreetMap webapp</a> for visual validation of the exact area you want to cover. <br><br>⚠️ Automatically defined City polygons may be smaller than expected (e.g., they don't include agglomeration areas). If you need to define the whole city area, head over to the 📡 <b>Geolocation parameters*</b> ...

          ## \`maxCrawledPlacesPerSearch\` optional integer prefill:50
          Number of results you expect to get per each Search term, Category or URL. The higher the number, the longer it will take. <br><br>If you want to scrape all places available, <b>leave this field empty</b> or use this section <b>🧭 Scrape all places on the map*</b>.

          ## \`language\` optional string prefill:en
          options: en, af, az, id, ms, bs, ca, cs, da, de, et, es, es-419, eu, fil, fr, gl, hr, zu, is, it, sw, lv, lt, hu, nl, no, uz, pl, pt-BR, pt-PT, ro, sq, sk, sl, fi, sv, vi, tr, el, bg, ky, kk, mk, mn, ru, sr, uk, ka, hy, iw, ur, ar, fa, am, ne, hi, mr, bn, pa, gu, ta, te, kn, ml, si, th, lo, my, km, ko, ja, zh-CN, zh-TW
          Scraping results will show in this language.

          ## \`categoryFilterWords\` optional array
          You can filter places by categories, which Google Maps has <a href='https://api.apify.com/v2/key-value-stores/epxZwNRgmnzzBpNJd/records/categories'>over 4,000</a>. Categories can be general, e.g. <b>beach</b>, which would include all places containing that word e.g. <b>black sand beach</b>, or specific, e.g. <b>beach club</b>. <br><br>⚠️ You can use <b>🎢 Place categories</b> alone or with <b>🔍 Search terms</b>. <b>🔍 Search terms</b> focus on searching, while <b>🎢 Categories</b> filter result...

          ## \`placeMinimumStars\` optional string default:<empty>
          options: <empty>, two, twoAndHalf, three, threeAndHalf, four, fourAndHalf
          Scrape only places with a rating equal to or above the selected stars. Places without reviews will also be skipped. Keep in mind, filtering by reviews reduces the number of places found per credit spent, as many will be excluded.

          ## \`website\` optional string default:allPlaces
          options: allPlaces, withWebsite, withoutWebsite
          Use this to exclude places without a website, or vice versa. This option is turned off by default.

          ## \`searchMatching\` optional string default:all
          options: all, only_includes, only_exact
          Restrict what places are scraped based on matching their name with provided 🔍 <b>Search term</b>. E.g., all places that have <b>chicken</b> in their name vs. places called <b>Kentucky Fried Chicken</b>.

          ## \`skipClosedPlaces\` optional boolean default:false
          Skip places that are marked as temporary or permanently closed. Ideal for focusing on currently open places.

          ## \`countryCode\` optional string
          options: <empty>, us, af, al, dz, as, ad, ao, ai, aq, ag, ar, am, aw, au, at, az, bs, bh, bd, bb, by, be, bz, bj, bm, bt, bo, ba, bw, bv, br, io, bn, bg, bf, bi, kh, cm, ca, cv, ky, cf, td, cl, cn, cx, cc, co, km, cg, cd, ck, cr, ci, hr, cu, cy, cz, dk, dj, dm, do, ec, eg, sv, gq, er, ee, et, fk, fo, fj, fi, fr, gf, pf, tf, ga, gm, ge, de, gh, gi, gr, gl, gd, gp, gu, gt, gn, gw, gy, ht, hm, va, hn, hk, hu, is, in
          Set the country where the data extraction should be carried out, e.g., <b>United States</b>.

          ## \`city\` optional string
          Enter the city where the data extraction should be carried out, e.g., <b>Pittsburgh</b>.<br><br>⚠️ <b>Do not include State or Country names here.</b><br><br>⚠️ Automatic City polygons may be smaller than expected (e.g., they don't include agglomeration areas). If you need that, set up the location using Country, State, County, City, or Postal code.<br>For an even more precise location definition (, head over to <b>🛰 Custom search area</b> section to create polygon shapes of the areas you want t...

          ## \`state\` optional string
          Set a state where the data extraction should be carried out, e.g., <b>Massachusetts</b> (mainly for the US addresses).

          ## \`county\` optional string
          Set the county where the data extraction should be carried out.<br><br>⚠️ Note that <b>county</b> may represent different administrative areas in different countries: a county (e.g., US), regional district (e.g., Canada) or département (e.g., France).

          ## \`postalCode\` optional string
          Set the postal code of the area where the data extraction should be carried out, e.g., <b>10001</b>. <br><br>⚠️ <b>Combine Postal code only with 🗺 Country, never with 🌇 City. You can only input one postal code at a time.</b>

          ## \`customGeolocation\` optional object
          Use this field to define the exact search area if other search area parameters don't work for you. See <a href='https://apify.com/compass/crawler-google-places#custom-search-area' target='_blank' rel='noopener'>readme</a> or <a href='https://blog.apify.com/google-places-api-limits/#1-create-a-custom-area-by-using-pairs-of-coordinates-%F0%9F%93%A1' target='_blank' rel='noopener'>our guide</a> for details.

          ## \`startUrls\` optional array
          Max 300 results per search URL. Valid format for URLs contains <code>google.com/maps/</code>. This feature also supports uncommon URL formats such as: <code>google.com?cid=***</code>, <code>goo.gl/maps</code>, and custom place list URL."
        `);
    });

    it('should format schema for rag web browser results', () => {
        const schema = {
            type: 'object',
            properties: {
                crawl: {
                    type: 'object',
                    properties: {
                        httpStatusCode: {
                            type: 'integer',
                        },
                        httpStatusMessage: {
                            type: 'string',
                        },
                        loadedAt: {
                            type: 'string',
                            format: 'date-time',
                        },
                        uniqueKey: {
                            type: 'string',
                        },
                        requestStatus: {
                            type: 'string',
                        },
                    },
                },
                searchResult: {
                    type: 'object',
                },
                metadata: {
                    type: 'object',
                },
                query: {
                    type: 'string',
                },
                markdown: {
                    type: 'string',
                    format: 'style',
                },
            },
        };

        const result = inputSchemaToMarkdown(schema);
        expect(result).toMatchInlineSnapshot(`
          "# JSON Schema

          ## \`crawl\` optional object
          ### \`httpStatusCode\` optional integer
          ### \`httpStatusMessage\` optional string
          ### \`loadedAt\` optional string format:date-time
          ### \`uniqueKey\` optional string
          ### \`requestStatus\` optional string

          ## \`searchResult\` optional object

          ## \`metadata\` optional object

          ## \`query\` optional string

          ## \`markdown\` optional string format:style"
        `);
    });
});
