const path = require("path");
const fs = require("fs-extra");

const CONFIG_FILE = path.resolve(__dirname, "../../config/judge-box.json");

let jsonConfig = {};
try {
    if (fs.existsSync(CONFIG_FILE)) {
        jsonConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
} catch (e) {
    console.error("[Config] Error parsing config/judge-box.json:", e.message);
}

let langConfig = {};
try {
    if (jsonConfig.languages && Object.keys(jsonConfig.languages).length > 0) {
        langConfig = jsonConfig.languages;
    }
} catch (e) {
    console.error("[Config] Error loading languages:", e.message);
}

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

const EXEC_MODE = jsonConfig.executionMode || "docker"; // 'docker' or 'isolate'
const PORT = jsonConfig.port || 3001;
const ENABLE_REDIS = jsonConfig.enableRedis !== undefined ? Boolean(jsonConfig.enableRedis) : true;
const LOG_LEVEL = jsonConfig.logLevel || "info";

const REDIS_CONFIG = jsonConfig.redis || {};
const REDIS_URL = REDIS_CONFIG.url || (REDIS_CONFIG.host && REDIS_CONFIG.port ? `redis://${REDIS_CONFIG.host}:${REDIS_CONFIG.port}` : "redis://127.0.0.1:6379");
const REDIS_PREFIX = REDIS_CONFIG.prefix || "";

const TEST_CACHE = jsonConfig.testCache || {};
const CACHE_ROOT = TEST_CACHE.dir || "/var/cache/judge/tests";

const LARAVEL_CONFIG = jsonConfig.laravel || {};
const JUDGE_SECRET_TOKEN = LARAVEL_CONFIG.secretToken || "judge-secret-token";
const LARAVEL_INTERNAL_URL = formatBaseUrl(LARAVEL_CONFIG.internalUrl || "http://127.0.0.1:8001/api/v1");

const DOCKER_CONFIG = jsonConfig.docker || {};
const AUTO_PULL_MISSING = DOCKER_CONFIG.autoPullMissingImages === true;
const SANDBOX_FLAGS = DOCKER_CONFIG.sandboxFlags || "--pids-limit 64 --cpus 1 --cap-drop=ALL --security-opt no-new-privileges --user 1000:1000";

const IOI_CONFIG = jsonConfig.ioi || {};
const IOI_TEST_CONCURRENCY = parseInt(IOI_CONFIG.testConcurrency, 10) || 1;

const REAPER_CONFIG = jsonConfig.reaper || {};
const STALE_MS = parseInt(REAPER_CONFIG.staleMs, 10) || 5 * 60 * 1000;
const SCAN_INTERVAL_MS = parseInt(REAPER_CONFIG.scanIntervalMs, 10) || 30 * 1000;

const ISOLATE_CONFIG = jsonConfig.isolate || {};

const DEFAULT_CONFIG = jsonConfig.defaults || {};
const DEFAULT_TIME_LIMIT = parseInt(DEFAULT_CONFIG.timeLimit, 10) || 1;
const DEFAULT_MEMORY_LIMIT = parseInt(DEFAULT_CONFIG.memoryLimit, 10) || 256;

module.exports = {
    config: jsonConfig,
    LANGS: langConfig,
    EXEC_MODE,
    PORT,
    ENABLE_REDIS,
    LOG_LEVEL,
    REDIS_URL,
    REDIS_PREFIX,
    REDIS_CONFIG,
    CACHE_ROOT,
    JUDGE_SECRET_TOKEN,
    AUTO_PULL_MISSING,
    IOI_TEST_CONCURRENCY,
    SANDBOX_FLAGS,
    LARAVEL_INTERNAL_URL,
    STALE_MS,
    SCAN_INTERVAL_MS,
    ISOLATE_CONFIG,
    DEFAULT_TIME_LIMIT,
    DEFAULT_MEMORY_LIMIT,
};