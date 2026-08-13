const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const fs = require("fs-extra");

const LANG_FILE = path.resolve(__dirname, "../../config/languages.json");
const LANGS = JSON.parse(fs.readFileSync(LANG_FILE, "utf8"));

const EXEC_MODE = process.env.EXEC_MODE || "docker"; // 'docker' or 'isolate'
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_PREFIX = process.env.REDIS_PREFIX || "";

const CACHE_ROOT = process.env.JUDGE_TEST_CACHE_DIR || "/var/cache/judge/tests";
const JUDGE_SECRET_TOKEN = process.env.JUDGE_SECRET_TOKEN;
const AUTO_PULL_MISSING = process.env.AUTO_PULL_MISSING_IMAGES === "1";

// Bounded parallelism for running independent test cases within the same
// subtask (IOI only — Classic/ICPC stop at the first failure anyway, so
// there's nothing to parallelize). Defaults to 1 (fully sequential,
// today's behavior). Raising this trades judging throughput for timing
// accuracy: running N containers at once on the same node means they
// share real CPU/memory, so a test's measured time/memory can be
// inflated by contention from its neighbors — a fairness concern for a
// judge, not just a performance knob. Only raise this deliberately, with
// per-test CPU/memory limits sized for the concurrency you pick.
const IOI_TEST_CONCURRENCY = parseInt(process.env.IOI_TEST_CONCURRENCY, 10) || 1;

const SANDBOX_FLAGS =
    "--pids-limit 64 --cpus 1 --cap-drop=ALL --security-opt no-new-privileges --user 1000:1000";

// Auto-formats a base URL: adds http:// if missing, inserts a colon
// before a bare port on localhost/127.0.0.1 if someone forgot it.
function formatBaseUrl(urlStr) {
    if (!urlStr) return "http://127.0.0.1:8000";
    let url = urlStr.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `http://${url}`;
    }
    url = url.replace(/(localhost|127\.0\.0\.1)(\d{4,5})/i, "$1:$2");
    return url.replace(/\/+$/, "");
}

const LARAVEL_INTERNAL_URL = formatBaseUrl(process.env.LARAVEL_INTERNAL_URL);

module.exports = {
    LANGS,
    EXEC_MODE,
    REDIS_URL,
    REDIS_PREFIX,
    CACHE_ROOT,
    JUDGE_SECRET_TOKEN,
    AUTO_PULL_MISSING,
    IOI_TEST_CONCURRENCY,
    SANDBOX_FLAGS,
    LARAVEL_INTERNAL_URL,
};