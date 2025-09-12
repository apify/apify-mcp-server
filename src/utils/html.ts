import * as cheerio from 'cheerio';

interface CheerioElementLike {
    attribs: Record<string, string>;
    tagName: string;
}

interface NodeLike {
    type: string;
}

/**
 * Strips HTML and keeps only the structure.
 *
 * Removes styles, scripts, and other non-content elements.
 * Collapses whitespace and trims the result.
 * Keeps only href, src, alt, id, class, title, name, data-* attributes.
 * Removes HTML comments and spaces between tags.
 * Removes base64 encoded images.
 */
export function stripHtml(html: string): string {
    const $ = cheerio.load(html);

    // Remove all attributes except href (only on a), src, alt, id, class, title, name, data-*
    const allowedAttrs = ['href', 'src', 'alt', 'id', 'class', 'title', 'name'];
    $('*').each((_, element) => {
        const { attribs } = (element as CheerioElementLike);
        if (attribs) {
            Object.keys(attribs).forEach((attr) => {
                if (attr === 'href' && (element as CheerioElementLike).tagName !== 'a') {
                    $(element).removeAttr(attr);
                } else if (!allowedAttrs.includes(attr) && !attr.startsWith('data-')) {
                    $(element).removeAttr(attr);
                }
            });
        }
    });

    // Remove <style>, <script>, <noscript>, <iframe>, <svg>, <canvas>, <math> tags and their content
    $('style, script, noscript, iframe, svg, canvas, math').remove();

    // Remove HTML comments
    $('*').contents().filter((_, element) => (element as NodeLike).type === 'comment').remove();

    // Remove base64 encoded images
    $('img[src^="data:image/"]').remove();

    let result;
    if (html.trim() === '') {
        result = '';
    } else if (html.includes('<html')) {
        result = $.html();
    } else {
        result = $('body').html() || '';
    }

    // Collapse multiple spaces into one, remove spaces between tags, and trim
    result = result.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    return result;
}
