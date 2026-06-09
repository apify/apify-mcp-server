#!/usr/bin/env node
// Validates the AGENTS.md tree so the "keep AGENTS.md updated" rule is mechanical:
//   - every relative link resolves on disk (no rot when a file is renamed/moved)
//   - every AGENTS.md is reachable from the root AGENTS.md (no orphan docs)
//   - every non-root AGENTS.md links up to an ancestor AGENTS.md
//   - an optional `<!-- agents-scope: dir -->` marker matches the file's location
// Anchors are not validated — heading slugs are fuzzy and not worth the false positives.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const rootDoc = join(root, 'AGENTS.md');
const SKIP = /(^|\/)(node_modules|dist|coverage|\.git)(\/|$)/;
const isDoc = (p) => p.endsWith('AGENTS.md') || p.endsWith('CLAUDE.md');

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (SKIP.test(path)) continue;
        if (statSync(path).isDirectory()) walk(path, out);
        else if (name === 'AGENTS.md') out.push(path);
    }
    return out;
}

const docs = walk(root);
const failures = [];
const linkedDocs = new Map();

for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    const dir = dirname(doc);
    const here = relative(root, dir) || '.';

    const scope = text.match(/<!--\s*agents-scope:\s*(\S+?)\/?\s*-->/)?.[1];
    if (scope && scope !== here) failures.push(`${relative(root, doc)}: scope '${scope}' != location '${here}'`);

    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((match) => match[1])
        .filter((link) => !/^(https?:|mailto:|#)/.test(link));

    const reachable = [];
    let hasUpLink = false;
    for (const link of targets) {
        const abs = resolve(dir, link.split(/[#?]/)[0]);
        if (!existsSync(abs)) {
            failures.push(`${relative(root, doc)}: dangling link -> ${link}`);
            continue;
        }
        if (!isDoc(abs)) continue;
        reachable.push(abs);
        const up = relative(dirname(abs), dir);
        if (up !== '' && !up.startsWith('..')) hasUpLink = true;
    }
    linkedDocs.set(doc, reachable);
    if (doc !== rootDoc && !hasUpLink) failures.push(`${relative(root, doc)}: no up-link to an ancestor AGENTS.md`);
}

const seen = new Set([rootDoc]);
const queue = [rootDoc];
while (queue.length > 0) {
    for (const next of linkedDocs.get(queue.shift()) ?? []) {
        if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
        }
    }
}
for (const doc of docs) {
    if (!seen.has(doc)) failures.push(`${relative(root, doc)}: orphan, unreachable from root AGENTS.md`);
}
if (!existsSync(rootDoc)) failures.push('AGENTS.md (repo root) is missing');

if (failures.length > 0) {
    process.stderr.write(`AGENTS.md link check failed:\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
}
process.stdout.write(`AGENTS.md link check passed (${docs.length} docs).\n`);
