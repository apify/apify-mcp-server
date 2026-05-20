/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

const pkgJson = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8'));

const PACKAGE_NAME = pkgJson.name;
const VERSION = pkgJson.version;

const nextVersion = addBetaSuffixToVersion(VERSION);
console.log(`before-deploy: Setting version to ${nextVersion}`);
pkgJson.version = nextVersion;

writeFileSync(PKG_JSON_PATH, `${JSON.stringify(pkgJson, null, 2)}\n`);

function addBetaSuffixToVersion(version) {
    // `pnpm view` instead of `npm show` because devEngines.packageManager is
    // pinned to pnpm with onFail: error, and npm enforces that check for every
    // subcommand (including read-only registry queries), so `npm show` fails
    // with EBADDEVENGINES at the repo root. `pnpm view` returns the same JSON
    // shape and skips the npm devEngines validation.
    const versionString = execSync(`pnpm view ${PACKAGE_NAME} versions --json`, { encoding: 'utf8' });
    const versions = JSON.parse(versionString);

    if (versions.some((v) => v === version)) {
        console.error(
            `before-deploy: A release with version ${version} already exists. Please increment version accordingly.`,
        );
        process.exit(1);
    }

    const prereleaseNumbers = versions
        .filter((v) => v.startsWith(version) && v.includes('-'))
        .map((v) => Number(v.match(/\.(\d+)$/)[1]));
    const lastPrereleaseNumber = Math.max(-1, ...prereleaseNumbers);
    return `${version}-beta.${lastPrereleaseNumber + 1}`;
}
