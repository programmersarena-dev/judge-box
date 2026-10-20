// In-memory image inventory — deliberately not persisted to a file.
// Docker's own local image store is already the single source of truth
// for "is <image>:<tag> present" — a JSON file cache would just be a
// second, driftable copy of that fact, stale the instant someone runs
// `docker pull`/`docker rmi`/`docker system prune` outside this process.
// A restart just re-syncs from reality; no staleness window, no
// cross-process file-locking to get wrong if multiple daemon processes
// run on the same box.

const { runCommand } = require("./runCommand");
const { AUTO_PULL_MISSING } = require("../config");

const localImages = new Set();

// Called once at startup, BEFORE the Redis consumer loop starts — see
// index.js. Jobs are only pulled from the queue once this has completed,
// so the very first job processed already benefits from a real
// inventory instead of hitting the cold-cache fallback path.
async function refreshLocalImageInventory() {
    const { out, code } = await runCommand('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
    if (code !== 0) {
        console.error("[Worker] Failed to list local docker images:", out);
        return;
    }
    localImages.clear();
    out.split("\n").map((l) => l.trim()).filter(Boolean).forEach((img) => localImages.add(img));
    console.log(`[Worker] Local image inventory: ${localImages.size} image(s) cached`);
}

// Fast path: in-memory Set. Slow path, only on a miss: ask Docker
// directly — covers another process on this host having pulled the
// image after our inventory was last built, without needing a
// background poll loop.
async function isImageAvailableLocally(image) {
    if (localImages.has(image)) return true;

    const { code } = await runCommand('docker', ['image', 'inspect', image]);
    if (code === 0) {
        localImages.add(image);
        return true;
    }
    return false;
}

// Off by default. Pulling a multi-hundred-MB image inline during a live
// submission blows time-limit accounting for whoever hits a cold node —
// this fleet is designed around pre-baked images for exactly that
// reason. Opt in via AUTO_PULL_MISSING_IMAGES=1 if you'd rather trade a
// slow first submission per node for not pre-provisioning by hand.
async function ensureLanguageAvailable(image) {
    if (await isImageAvailableLocally(image)) return { available: true };
    if (!AUTO_PULL_MISSING) return { available: false };

    console.warn(`[Worker] ${image} not present locally, pulling (AUTO_PULL_MISSING_IMAGES=1)...`);
    const { code, out } = await runCommand('docker', ['pull', image], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    if (code === 0) {
        localImages.add(image);
        return { available: true };
    }
    return { available: false, error: out };
}

async function getAvailableLanguages(langsConfig) {
    const available = [];
    for (const [langKey, langConfig] of Object.entries(langsConfig || {})) {
        for (const version of langConfig.versions || []) {
            const dockerImage = `${langConfig.dockerImage}:${version}`;
            if (await isImageAvailableLocally(dockerImage)) {
                available.push(`${langKey}-${version}`);
            }
        }
    }
    return available;
}

module.exports = { refreshLocalImageInventory, isImageAvailableLocally, ensureLanguageAvailable, getAvailableLanguages };
