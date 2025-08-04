/* eslint-disable no-console */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PKG_JSON_PATH = path.join(__dirname, '..', '..', 'package.json');

function execCommand(command, options = {}) {
    try {
        return execSync(command, { encoding: 'utf8', ...options }).trim();
    } catch (error) {
        console.error(`Command failed: ${command}`);
        console.error(error.message);
        process.exit(1);
        return null; // Ensure a return value for all code paths
    }
}

function getPackageInfo() {
    const pkgJson = JSON.parse(fs.readFileSync(PKG_JSON_PATH, 'utf8'));
    return {
        name: pkgJson.name,
        version: pkgJson.version,
        pkgJson,
    };
}

function getBaseVersionFromGit() {
    try {
        // Get the base version from the latest commit that updated package.json
        // This ensures we use the version that was set by the release_metadata step
        const gitShow = execCommand('git show HEAD:package.json');
        const gitPackageJson = JSON.parse(gitShow);
        return gitPackageJson.version;
    } catch (error) {
        console.error('Could not get base version from git');
        throw error;
    }
}

function getNextBetaVersion(packageName, baseVersion) {
    console.log(`Calculating next beta version for base: ${baseVersion}`);

    // Validate base version format
    if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
        console.error(`Invalid base version format: ${baseVersion}`);
        process.exit(1);
    }

    let npmBetaNumber = 0;
    let gitBetaNumber = 0;

    // Check NPM for existing beta versions
    try {
        const versionString = execCommand(`npm show ${packageName} versions --json`);
        const versions = JSON.parse(versionString);

        // Check if base version already exists as stable
        if (versions.includes(baseVersion)) {
            console.error(`Base version ${baseVersion} already exists as stable on NPM!`);
            process.exit(1);
        }

        const versionPrefix = `${baseVersion}-beta.`;
        const npmBetas = versions
            .filter((v) => v.startsWith(versionPrefix))
            .map((v) => {
                const match = v.match(/^.+-beta\.(\d+)$/);
                return match ? parseInt(match[1], 10) : 0;
            });

        npmBetaNumber = npmBetas.length > 0 ? Math.max(...npmBetas) : 0;
        console.log(`Latest beta on NPM: ${npmBetaNumber}`);
    } catch {
        console.log('No existing versions found on NPM');
    }

    // Check Git tags for existing beta versions
    try {
        const tagPattern = `v${baseVersion}-beta.*`;
        const tags = execCommand(`git tag -l "${tagPattern}" --sort=-version:refname`);

        if (tags) {
            const tagList = tags.split('\n').filter((tag) => tag.trim());
            if (tagList.length > 0) {
                const latestTag = tagList[0];
                const match = latestTag.match(/v\d+\.\d+\.\d+-beta\.(\d+)$/);
                if (match) {
                    gitBetaNumber = parseInt(match[1], 10);
                    console.log(`Latest beta in Git: ${gitBetaNumber}`);
                }
            }
        }
    } catch {
        console.log('No existing beta tags found in Git');
    }

    // Use the higher number to avoid conflicts
    const nextBetaNumber = Math.max(npmBetaNumber, gitBetaNumber) + 1;
    const nextVersion = `${baseVersion}-beta.${nextBetaNumber}`;

    console.log(`Next beta version: ${nextVersion}`);
    return nextVersion;
}

function updatePackageVersion(newVersion) {
    const { pkgJson } = getPackageInfo();
    pkgJson.version = newVersion;
    fs.writeFileSync(PKG_JSON_PATH, `${JSON.stringify(pkgJson, null, 2)}\n`);
    console.log(`Updated package.json to ${newVersion}`);
}

function main() {
    console.log('🚀 Starting beta version calculation...');

    const { name: packageName } = getPackageInfo();

    // Get the base version from Git (what was committed by release_metadata)
    const baseVersion = getBaseVersionFromGit();
    console.log(`Base version from Git: ${baseVersion}`);

    // Calculate next beta version
    const nextBetaVersion = getNextBetaVersion(packageName, baseVersion);

    // Update package.json with the beta version
    updatePackageVersion(nextBetaVersion);

    console.log('✅ Beta version preparation completed!');
    console.log(`Package will be published as: ${nextBetaVersion}`);
}

main();
