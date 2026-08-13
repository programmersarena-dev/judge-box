const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const extractZip = require("extract-zip");
const { CACHE_ROOT, LARAVEL_INTERNAL_URL, JUDGE_SECRET_TOKEN } = require("../config");

// Fetches and extracts a problem's test bundle exactly once per
// (problem, version) pair on this node, then reuses the local copy for
// every subsequent submission. `version` should change whenever the
// tests actually do — GradeSubmissionJob.php passes problem.test_cases_path
// directly, since that already changes on every admin re-upload.
async function ensureTestCasesCached(problemId, version) {
    if (!problemId || !version) return null;

    const cacheDir = path.join(CACHE_ROOT, `${problemId}-${version}`);
    if (await fs.pathExists(cacheDir)) {
        return cacheDir;
    }

    await fs.mkdirp(CACHE_ROOT);
    const zipPath = path.join(CACHE_ROOT, `${problemId}-${version}.zip`);
    const downloadUrl = `${LARAVEL_INTERNAL_URL}/internal/test-cases/${problemId}`;
    console.log(`[Worker] Downloading test bundle from: ${downloadUrl}`);

    const response = await axios.get(downloadUrl, {
        headers: { "X-Judge-Token": JUDGE_SECRET_TOKEN },
        responseType: "stream",
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(zipPath);
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
    });

    await fs.mkdirp(cacheDir);
    await extractZip(zipPath, { dir: cacheDir });
    await fs.remove(zipPath);

    return cacheDir;
}

// Reads a test file from the local cache if a reference was given, else
// falls back to inline content — supports both job payload shapes during
// a gradual rollout.
async function readTestFile(cacheDir, relativeFile, inlineFallback) {
    if (relativeFile && cacheDir) {
        return fs.readFile(path.join(cacheDir, relativeFile), "utf8");
    }
    return inlineFallback || "";
}

module.exports = { ensureTestCasesCached, readTestFile };