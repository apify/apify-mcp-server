import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApifySkillsCheckout } from '../../evals/workflows/apify_skills.js';
import { assertSkillsExist, listSkillNames } from '../../evals/workflows/apify_skills.js';

/** Plugin checkout on disk, like the cloned skills repo: `skills/<name>/SKILL.md`. */
function makePluginCheckout(skills: Record<string, string[]>): string {
    const pluginPath = mkdtempSync(join(tmpdir(), 'apify-skills-test-'));
    for (const [name, files] of Object.entries(skills)) {
        const skillDir = join(pluginPath, 'skills', name);
        mkdirSync(skillDir, { recursive: true });
        for (const file of files) writeFileSync(join(skillDir, file), '# skill\n');
    }
    return pluginPath;
}

describe('listSkillNames()', () => {
    let pluginPath: string;

    afterEach(() => {
        if (pluginPath) rmSync(pluginPath, { recursive: true, force: true });
    });

    it('returns the skills of a checkout, sorted', () => {
        pluginPath = makePluginCheckout({
            'apify-ultimate-scraper': ['SKILL.md'],
            'apify-actor-development': ['SKILL.md'],
        });
        expect(listSkillNames(pluginPath)).toEqual(['apify-actor-development', 'apify-ultimate-scraper']);
    });

    it('skips a directory without a SKILL.md, so a stray one is not offered as a skill', () => {
        pluginPath = makePluginCheckout({ 'apify-ultimate-scraper': ['SKILL.md'], references: ['gotchas.md'] });
        expect(listSkillNames(pluginPath)).toEqual(['apify-ultimate-scraper']);
    });

    it('returns nothing when the checkout has no skills directory', () => {
        pluginPath = makePluginCheckout({});
        expect(listSkillNames(pluginPath)).toEqual([]);
    });
});

describe('assertSkillsExist()', () => {
    let checkout: ApifySkillsCheckout;

    beforeEach(() => {
        checkout = {
            pluginPath: '/tmp/plugin',
            commit: 'abc123',
            available: ['apify-actor-development', 'apify-ultimate-scraper'],
        };
    });

    it('accepts skills the checkout provides', () => {
        expect(() => assertSkillsExist(checkout, ['apify-ultimate-scraper'])).not.toThrow();
    });

    it('accepts an empty request', () => {
        expect(() => assertSkillsExist(checkout, [])).not.toThrow();
    });

    it('throws naming the unknown skill and what the checkout provides', () => {
        expect(() => assertSkillsExist(checkout, ['apify-ultimate-scraper', 'ultimate-scraper'])).toThrow(
            /Unknown Apify skill\(s\): ultimate-scraper.*apify-actor-development, apify-ultimate-scraper/s,
        );
    });

    it('reports an unknown skill once however often it was requested', () => {
        expect(() => assertSkillsExist(checkout, ['typo', 'typo'])).toThrow(/skill\(s\): typo\./);
    });
});
