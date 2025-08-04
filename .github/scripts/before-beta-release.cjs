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
    }

    return null;
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

function incrementVersion(version, type = 'patch') {
    const [major, minor, patch] = version.split('.').map(Number);

    switch (type) {
        case 'major':
            return `${major + 1}.0.0`;
        case 'minor':
            return `${major}.${minor + 1}.0`;
        case 'patch':
        default:
            return `${major}.${minor}.${patch + 1}`;
    }
}

function findNextAvailableVersion(packageName, baseVersion) {
    console.log(`Finding next available version starting from: ${baseVersion}`);

    try {
        const versionString = execCommand(`npm show ${packageName} versions --json`);
        const versions = JSON.parse(versionString);

        let currentVersion = baseVersion;

        // Keep incrementing patch version until we find one that doesn't exist
        while (versions.includes(currentVersion)) {
            console.log(`Version ${currentVersion} already exists as stable, incrementing...`);
            currentVersion = incrementVersion(currentVersion, 'patch');
        }

        console.log(`Next available base version: ${currentVersion}`);
        return currentVersion;
    } catch {
        console.log('Could not check NPM versions, using provided base version');
        return baseVersion;
    }
}

function getNextBetaVersion(packageName, baseVersion) {
    console.log(`Calculating next beta version for base: ${baseVersion}`);

    // Validate base version format
    if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
        console.error(`Invalid base version format: ${baseVersion}`);
        process.exit(1);
    }

    // Find the next available base version if current one exists as stable
    const availableBaseVersion = findNextAvailableVersion(packageName, baseVersion);

    let npmBetaNumber = 0;
    let gitBetaNumber = 0;

    // Check NPM for existing beta versions of the available base version
    try {
        const versionString = execCommand(`npm show ${packageName} versions --json`);
        const versions = JSON.parse(versionString);

        const versionPrefix = `${availableBaseVersion}-beta.`;
        const npmBetas = versions
            .filter((v) => v.startsWith(versionPrefix))
            .map((v) => {
                const match = v.match(/^.+-beta\.(\d+)$/);
                return match ? parseInt(match[1], 10) : 0;
            });

        npmBetaNumber = npmBetas.length > 0 ? Math.max(...npmBetas) : 0;
        console.log(`Latest beta on NPM for ${availableBaseVersion}: ${npmBetaNumber}`);
    } catch {
        console.log('No existing beta versions found on NPM');
    }

    // Check Git tags for existing beta versions of the available base version
    try {
        const tagPattern = `v${availableBaseVersion}-beta.*`;
        const tags = execCommand(`git tag -l "${tagPattern}" --sort=-version:refname`);

        if (tags) {
            const tagList = tags.split('\n').filter((tag) => tag.trim());
            if (tagList.length > 0) {
                const latestTag = tagList[0];
                const match = latestTag.match(/v\d+\.\d+\.\d+-beta\.(\d+)$/);
                if (match) {
                    gitBetaNumber = parseInt(match[1], 10);
                    console.log(`Latest beta in Git for ${availableBaseVersion}: ${gitBetaNumber}`);
                }
            }
        }
    } catch {
        console.log('No existing beta tags found in Git');
    }

    // Use the higher number to avoid conflicts
    const nextBetaNumber = Math.max(npmBetaNumber, gitBetaNumber) + 1;
    const nextVersion = `${availableBaseVersion}-beta.${nextBetaNumber}`;

    console.log(`Next beta version: ${nextVersion}`);
    return nextVersion;
}

function saveBetaVersionToFile(version) {
    // Save version to temporary file for workflow to read
    fs.writeFileSync('/tmp/beta_version.txt', version);
    console.log(`Saved beta version to /tmp/beta_version.txt: ${version}`);
}

function main() {
    console.log('🚀 Starting beta version calculation...');

    const { name: packageName } = getPackageInfo();

    // Get the base version from Git (what was committed by release_metadata)
    const baseVersion = getBaseVersionFromGit();
    console.log(`Base version from Git: ${baseVersion}`);

    // Calculate next beta version (will auto-increment if base version exists as stable)
    const nextBetaVersion = getNextBetaVersion(packageName, baseVersion);

    // Only calculate and save to file, don't update package.json
    saveBetaVersionToFile(nextBetaVersion);
    console.log('✅ Beta version calculation completed!');
    console.log(`Beta version calculated: ${nextBetaVersion}`);
}

main();
