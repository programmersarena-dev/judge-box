const Redis = require("ioredis");
const os = require("os");
const { REDIS_URL, REDIS_PREFIX } = require("./config");
const { processJob } = require("./processJob");
const { setSubmissionJudging, setSubmissionFinished } = require('./lib/redis');

const redis = new Redis(REDIS_URL, { keyPrefix: REDIS_PREFIX });

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const IN_PROGRESS_KEY = `judge:jobs:in-progress:${WORKER_ID}`;
const PROCESSING_HASH = "judge:jobs:processing_at";
const MAX_SKIPS = 3;

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
            const submissionId = job.submission_id || job.submissionId || String(job.id).match(/^sub-(\d+)-/)?.[1];
            const queueStateKey = submissionId ? `judge:submission:${submissionId}:queue-state` : null;
            if (queueStateKey) await redis.set(queueStateKey, 'Judging', 'EX', 86400);
            await setSubmissionJudging(submissionId);

            let result;
            try {
                result = await processJob(job);
            } catch (e) {
                console.error(`[${WORKER_ID}] processJob threw for ${job.id}:`, e);
                result = { status: "Judge Error", error_message: String(e) };
            }

            if (result && result._skip) {
                const skipKey = `judge:job:${job.id}:skips`;
                const skipCount = await redis.hincrby(skipKey, "count", 1);

                if (skipCount >= MAX_SKIPS) {
                    await setSubmissionFinished(submissionId, { status: 'Judge Error' });
                    if (queueStateKey) await redis.del(queueStateKey);
                    await redis.lpush("judge:results", JSON.stringify({
                        id: job.id || null,
                        result: {
                            status: "Judge Error",
                            error_message: "No judge node available for this language/version",
                        },
                    }));
                    await redis.lrem(IN_PROGRESS_KEY, 1, raw);
                    await redis.hdel(PROCESSING_HASH, job.id);
                    await redis.del(skipKey);
                    continue;
                }

                await redis.lpush("judge:jobs", raw);
                if (queueStateKey) await redis.set(queueStateKey, 'In Queue', 'EX', 86400);
                await setSubmissionJudging(submissionId, { status: 'In Queue' });
                await redis.lrem(IN_PROGRESS_KEY, 1, raw);
                await redis.hdel(PROCESSING_HASH, job.id);
                continue;
            }

            await setSubmissionFinished(submissionId, result);
            await redis.lpush("judge:results", JSON.stringify({ id: job.id || null, result }));
            if (queueStateKey) await redis.del(queueStateKey);

            await redis.lrem(IN_PROGRESS_KEY, 1, raw);
            await redis.hdel(PROCESSING_HASH, job.id);
        }
    } catch (err) {
        console.error("Redis worker error", err);
        setTimeout(startRedisWorker, 3000);
    }
}

module.exports = { startRedisWorker, WORKER_ID };
