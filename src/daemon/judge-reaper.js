// Run as a single standalone process (systemd unit on any one box that
// can reach Redis — doesn't need to be a judge node itself). Periodically
// scans every worker's in-progress list for jobs that were picked up but
// never finished, and puts them back on the main queue.
//
// IMPORTANT: set JUDGE_STALE_MS comfortably above your worst realistic
// total judge time (compile + every subtask + container startup
// overhead). Too low and you'll get false positives: a worker that's
// still alive and correctly grinding through a slow submission gets its
// job requeued and picked up by a second worker too, so the same
// submission is judged twice and whichever result lands last in
// judge:results silently wins. Too high just means a genuinely dead
// worker's job sits unprocessed a bit longer before recovery — much
// safer failure mode than duplicate judging.

const Redis = require("ioredis");
const { REDIS_URL, REDIS_PREFIX } = require("./config");

const STALE_MS = parseInt(process.env.JUDGE_STALE_MS, 10) || 5 * 60 * 1000; // 5 min
const SCAN_INTERVAL_MS = 30 * 1000;

const redis = new Redis(REDIS_URL, { keyPrefix: REDIS_PREFIX });

async function scanKeys(pattern) {
    const keys = [];
    let cursor = "0";
    do {
        // SCAN, not KEYS — KEYS blocks the whole Redis instance on large
        // keyspaces; SCAN walks it incrementally without blocking.
        const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = next;
        keys.push(...batch);
    } while (cursor !== "0");
    return keys;
}

async function reapOnce() {
    const inProgressKeys = await scanKeys("judge:jobs:in-progress:*");

    for (const key of inProgressKeys) {
        const items = await redis.lrange(key, 0, -1);

        for (const raw of items) {
            let job;
            try {
                job = JSON.parse(raw);
            } catch {
                continue;
            }

            const pickedUpAt = await redis.hget("judge:jobs:processing_at", job.id);
            const age = pickedUpAt ? Date.now() - Number(pickedUpAt) : Infinity;

            if (age > STALE_MS) {
                // Requeue BEFORE removing from the dead list — if this reaper
                // itself crashes mid-way, the job is briefly in both places
                // rather than briefly in neither.
                await redis.lpush("judge:jobs", raw);
                await redis.lrem(key, 1, raw);
                await redis.hdel("judge:jobs:processing_at", job.id);
                console.warn(
                    `[reaper] Requeued stale job ${job.id} from ${key} (age ${Math.round(age / 1000)}s)`
                );
            }
        }
    }
}

async function main() {
    console.log(`[reaper] Watching for jobs stuck longer than ${STALE_MS}ms`);
    while (true) {
        try {
            await reapOnce();
        } catch (e) {
            console.error("[reaper] error", e);
        }
        await new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS));
    }
}

main();