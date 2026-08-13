const Redis = require("ioredis");
const os = require("os");
const { REDIS_URL, REDIS_PREFIX } = require("./config");
const { processJob } = require("./processJob");

const redis = new Redis(REDIS_URL, { keyPrefix: REDIS_PREFIX });

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const IN_PROGRESS_KEY = `judge:jobs:in-progress:${WORKER_ID}`;
const PROCESSING_HASH = "judge:jobs:processing_at";

async function startRedisWorker() {
    try {
        const queueName = "judge:jobs";
        console.log(`[${WORKER_ID}] Listening on queue: ${queueName}`);

        while (true) {
            const raw = await redis.brpoplpush(queueName, IN_PROGRESS_KEY, 0);
            if (!raw) continue;

            let job;
            try {
                job = JSON.parse(raw);
            } catch (e) {
                console.error("Invalid job payload from Redis");
                await redis.lrem(IN_PROGRESS_KEY, 1, raw);
                continue;
            }

            await redis.hset(PROCESSING_HASH, job.id, Date.now());

            let result;
            try {
                result = await processJob(job);
            } catch (e) {
                console.error(`[${WORKER_ID}] processJob threw for ${job.id}:`, e);
                result = { status: "Judge Error", error_message: String(e) };
            }

            await redis.lpush("judge:results", JSON.stringify({ id: job.id || null, result }));

            await redis.lrem(IN_PROGRESS_KEY, 1, raw);
            await redis.hdel(PROCESSING_HASH, job.id);
        }
    } catch (err) {
        console.error("Redis worker error", err);
        setTimeout(startRedisWorker, 3000);
    }
}

module.exports = { startRedisWorker, WORKER_ID };