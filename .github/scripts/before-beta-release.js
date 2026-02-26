/* eslint-disable no-console */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PKG_JSON_PATH = path.join(__dirname, '..', '..', 'package.json');

// eslint-disable-next-line import/no-dynamic-require
const pkgJson = require(PKG_JSON_PATH);

const PACKAGE_NAME = pkgJson.name;
const VERSION = pkgJson.version;

const nextVersion = addBetaSuffixToVersion(VERSION);
console.log(`before-deploy: Setting version to ${nextVersion}`);
pkgJson.version = nextVersion;

fs.writeFileSync(PKG_JSON_PATH, `${JSON.stringify(pkgJson, null, 2)}\n`);

function addBetaSuffixToVersion(version) {
    const versionString = execSync(`npm show ${PACKAGE_NAME} versions --json`, { encoding: 'utf8' });
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
