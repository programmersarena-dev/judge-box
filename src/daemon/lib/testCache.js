const fs = require('fs-extra');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const extractZip = require('extract-zip');
const { CACHE_ROOT, LARAVEL_INTERNAL_URL, JUDGE_SECRET_TOKEN } = require('../config');
const downloads = new Map();

async function ensureTestCasesCached(problemId, version) {
    if (!problemId || !version) return null;
    if (!/^\d+$/.test(String(problemId)) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(version))) {
        throw new Error('Invalid test bundle identifier');
    }
    const key = `${problemId}-${version}`;
    if (!downloads.has(key)) {
        downloads.set(key, downloadBundle(problemId, String(version), key).finally(() => downloads.delete(key)));
    }
    return downloads.get(key);
}

async function downloadBundle(problemId, version, key) {
    const cacheDir = path.join(CACHE_ROOT, `v2-${key}`);
    if (await fs.pathExists(path.join(cacheDir, '.complete'))) return cacheDir;
    await fs.mkdirp(CACHE_ROOT);
    const staging = await fs.mkdtemp(path.join(CACHE_ROOT, '.download-'));
    try {
        const response = await axios.get(`${LARAVEL_INTERNAL_URL}/internal/test-cases/${problemId}`, {
            headers: { 'X-Judge-Token': JUDGE_SECRET_TOKEN },
            params: version.length === 64 ? { version } : {},
            responseType: 'stream', timeout: 60000,
        });
        const archive = path.join(staging, 'tests.zip');
        await pipeline(response.data, fs.createWriteStream(archive));
        const extracted = path.join(staging, 'bundle');
        await fs.mkdirp(extracted);
        await extractZip(archive, { dir: extracted });
        await fs.writeFile(path.join(extracted, '.complete'), 'ok');
        try {
            await fs.rename(extracted, cacheDir);
        } catch (error) {
            if (!(await fs.pathExists(path.join(cacheDir, '.complete')))) throw error;
        }
        return cacheDir;
    } finally {
        await fs.remove(staging);
    }
}

async function readTestFile(cacheDir, relativeFile, inlineFallback) {
    if (relativeFile) {
        if (!cacheDir || path.isAbsolute(relativeFile) || relativeFile.includes('\\')) {
            throw new Error('Invalid test file reference');
        }
        const root = await fs.realpath(cacheDir);
        const candidate = path.resolve(root, relativeFile);
        if (!candidate.startsWith(root + path.sep)) throw new Error('Test file escapes cache directory');
        const actual = await fs.realpath(candidate);
        if (!actual.startsWith(root + path.sep)) throw new Error('Test symlink escapes cache directory');
        return fs.readFile(actual, 'utf8');
    }
    return inlineFallback || '';
}

module.exports = { ensureTestCasesCached, readTestFile };
