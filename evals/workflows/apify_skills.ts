/**
 * Apify agent skills for the agent under test.
 *
 * Skills are published in the `apify/agent-skills` repo, which is itself a Claude Code
 * plugin (`skills/<name>/SKILL.md`). A run that needs any skill shallow-clones the repo
 * and registers the checkout with the Agent SDK as a local plugin, so a case is evaluated
 * against the same skill text a real user installs.
 *
 * Cloned per run into a temp dir rather than cached: a cached copy would silently make a
 * run measure a stale skill, and there is no cheap way to tell that from the outside.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where Apify publishes its agent skills. */
export const APIFY_SKILLS_REPO_URL = 'https://github.com/apify/agent-skills.git';

export type ApifySkillsCheckout = {
    /** Plugin root the Agent SDK loads the skills from. */
    pluginPath: string;
    /** Commit the run used. Recorded in the run metadata: upstream skills move. */
    commit: string;
    /** Skill names the checkout provides. */
    available: string[];
};

/** Skill names in a plugin checkout: the directories under `skills/` that hold a SKILL.md. */
export function listSkillNames(pluginPath: string): string[] {
    const skillsDir = join(pluginPath, 'skills');
    if (!existsSync(skillsDir)) return [];

    return readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
        .sort();
}

/** Shallow-clone the skills repo. Call `removeApifySkills` when the run is over. */
export function cloneApifySkills(): ApifySkillsCheckout {
    const pluginPath = mkdtempSync(join(tmpdir(), 'apify-agent-skills-'));
    execFileSync('git', ['clone', '--depth', '1', APIFY_SKILLS_REPO_URL, pluginPath], { stdio: 'pipe' });
    const commit = execFileSync('git', ['-C', pluginPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    return { pluginPath, commit, available: listSkillNames(pluginPath) };
}

export function removeApifySkills(checkout: ApifySkillsCheckout): void {
    rmSync(checkout.pluginPath, { recursive: true, force: true });
}

/**
 * Fail before any test runs when a requested skill is not in the checkout.
 *
 * The SDK's `skills` option is a filter: an unknown name is silently dropped, so a
 * misspelled skill would leave the agent running without it and the case would measure
 * the server's tools alone while claiming to measure the skill.
 */
export function assertSkillsExist(checkout: ApifySkillsCheckout, requested: string[]): void {
    const unknown = [...new Set(requested)].filter((name) => !checkout.available.includes(name)).sort();
    if (unknown.length === 0) return;

    throw new Error(
        `Unknown Apify skill(s): ${unknown.join(', ')}. ` +
            `${APIFY_SKILLS_REPO_URL} (commit ${checkout.commit}) provides: ${checkout.available.join(', ') || '(none)'}`,
    );
}
