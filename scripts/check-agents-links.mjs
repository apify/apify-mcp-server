#!/usr/bin/env node
// CI gate for the AGENTS.md tree:
//   1. every relative link in an AGENTS.md resolves on disk (catches moved/renamed files)
//   2. every AGENTS.md is reachable from the root by following links (no orphan docs)
// Links inside code blocks/spans, `scheme:` URLs, and `#anchor`-only targets are skipped;
// heading anchors themselves are not validated.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const rootDoc = join(root, 'AGENTS.md');
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', '.shepherd']);

// `withFileTypes` reports the entry kind without a stat() that would follow — and
// throw on — a broken symlink, so the walk never crashes on one.
function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) walk(join(dir, entry.name), out);
        } else if (entry.name === 'AGENTS.md') {
            out.push(join(dir, entry.name));
        }
    }
    return out;
}

const docs = walk(root);
const docSet = new Set(docs);
const childLinks = new Map();
const failures = [];

if (!docSet.has(rootDoc)) failures.push('AGENTS.md (repo root) is missing');

for (const doc of docs) {
    const dir = dirname(doc);
    const body = readFileSync(doc, 'utf8')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '');
    const children = [];
    for (const [, link] of body.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z][\w+.-]*:|^#/i.test(link)) continue;
        const target = resolve(dir, link.split('#')[0]);
        if (!existsSync(target)) {
            failures.push(`${relative(root, doc)}: dangling link -> ${link}`);
        } else if (docSet.has(target)) {
            children.push(target);
        }
    }
    childLinks.set(doc, children);
}

const seen = new Set([rootDoc]);
const queue = [rootDoc];
while (queue.length > 0) {
    for (const next of childLinks.get(queue.shift()) ?? []) {
        if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
        }
    }
}
for (const doc of docs) {
    if (!seen.has(doc)) failures.push(`${relative(root, doc)}: orphan, not reachable from root AGENTS.md`);
}

if (failures.length > 0) {
    process.stderr.write(`AGENTS.md link check failed:\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
}
process.stdout.write(`AGENTS.md link check passed (${docs.length} docs).\n`);
