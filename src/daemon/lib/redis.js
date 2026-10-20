const Redis = require("ioredis");
const { REDIS_URL, REDIS_PREFIX } = require("../config");

let redisClient = null;

function getRedisClient() {
    if (!redisClient) {
        redisClient = new Redis(REDIS_URL, {
            keyPrefix: REDIS_PREFIX,
            maxRetriesPerRequest: 3,
            enableOfflineQueue: true,
            retryStrategy(times) {
                return Math.min(times * 100, 2000);
            },
        });

        redisClient.on("error", (err) => {
            console.error("[Redis] Connection error:", err.message);
        });
    }
    return redisClient;
}

/**
 * Updates status, time, memory, and test progress for a submission in Redis.
 *
 * @param {string|number} submissionId
 * @param {object} testInfo
 */
async function updateSubmissionTestStatus(submissionId, testInfo = {}) {
    if (!submissionId) return;

    try {
        const client = getRedisClient();
        const {
            status,
            time,
            memory,
            testIndex,
            maxTimeMs,
            maxMemoryKb,
            totalTests,
            subtask,
        } = testInfo;

        const testNum = typeof testIndex === "number" ? testIndex + 1 : (testInfo.test || 1);
        let statusText = status;

        const hashKey = `judge:submission:${submissionId}`;
        const statusKey = `judge:submission:${submissionId}:status`;
        const legacyKey = `submission:${submissionId}:status`;

        const testEntry = {
            test: testNum,
            status: statusText,
            time: Number(time) || 0,
            memory: Number(memory) || 0,
            updated_at: Date.now(),
        };

        const hashPayload = {
            finished: '0',
            status: statusText,
            time: String(time ?? 0),
            memory: String(memory ?? 0),
            test: String(testNum ?? 1),
            test_index: String(testIndex ?? 0),
            updated_at: String(Date.now()),
        };

        if (maxTimeMs !== undefined) {
            hashPayload.max_time = String(maxTimeMs);
        }
        if (maxMemoryKb !== undefined) {
            hashPayload.max_memory = String(maxMemoryKb);
        }
        if (totalTests !== undefined) {
            hashPayload.total_tests = String(totalTests);
        }
        if (subtask !== undefined) {
            hashPayload.subtask = String(subtask);
        }

        // Store as Redis Hash on primary and fallback keys
        await client.hset(hashKey, hashPayload);
        await client.expire(hashKey, 86400);

        await client.hset(statusKey, hashPayload);
        await client.expire(statusKey, 86400);

        await client.hset(legacyKey, hashPayload);
        await client.expire(legacyKey, 86400);

        // Append to test history list in Redis
        const listKey = `judge:submission:${submissionId}:tests`;
        await client.rpush(listKey, JSON.stringify(testEntry));
        await client.expire(listKey, 86400);

        // Publish event for real-time subscribers
        const channel = `judge:submission:${submissionId}:events`;
        await client.publish(channel, JSON.stringify(testEntry)).catch(() => {});
    } catch (err) {
        console.error(`[Redis] Failed to update test status for submission ${submissionId}:`, err.message);
    }
}

/**
 * Initializes judging status in Redis when a worker begins processing a submission.
 */
async function setSubmissionJudging(submissionId, initialInfo = {}) {
    if (!submissionId) return;

    try {
        const client = getRedisClient();
        const hashKey = `judge:submission:${submissionId}`;
        const statusKey = `judge:submission:${submissionId}:status`;
        const legacyKey = `submission:${submissionId}:status`;

        const payload = {
            finished: '0',
            status: initialInfo.status || "Judging",
            time: String(initialInfo.time || 0),
            memory: String(initialInfo.memory || 0),
            test: "0",
            test_index: "0",
            subtask: "0",
            updated_at: String(Date.now()),
        };

        // Clear previous tests if re-judging
        await client.del(`judge:submission:${submissionId}:tests`).catch(() => {});

        await client.hset(hashKey, payload);
        await client.expire(hashKey, 86400);

        await client.hset(statusKey, payload);
        await client.expire(statusKey, 86400);

        await client.hset(legacyKey, payload);
        await client.expire(legacyKey, 86400);
    } catch (err) {
        console.error(`[Redis] Failed to set judging status for submission ${submissionId}:`, err.message);
    }
}

/**
 * Updates submission with final status, max time, max memory, and subtasks/tests when finished.
 */
async function setSubmissionFinished(submissionId, finalResult = {}) {
    if (!submissionId) return;

    try {
        const client = getRedisClient();
        const hashKey = `judge:submission:${submissionId}`;
        const statusKey = `judge:submission:${submissionId}:status`;
        const legacyKey = `submission:${submissionId}:status`;

        const payload = {
            finished: '1',
            status: String(finalResult.status ?? "Finished"),
            time: String(finalResult.max_time_used_ms ?? finalResult.time ?? 0),
            memory: String(finalResult.max_memory_used_kb ?? finalResult.memory ?? 0),
            max_time: String(finalResult.max_time_used_ms ?? finalResult.time ?? 0),
            max_memory: String(finalResult.max_memory_used_kb ?? finalResult.memory ?? 0),
            error_message: String(finalResult.error_message || ""),
            updated_at: String(Date.now()),
            test: "0",
            test_index: "0",
            subtask: "0",
        };

        if (finalResult.subtasks) {
            payload.subtasks = JSON.stringify(finalResult.subtasks);
            payload.tests = JSON.stringify(finalResult.subtasks);
        }

        await client.hset(hashKey, payload);
        await client.expire(hashKey, 86400);

        await client.hset(statusKey, payload);
        await client.expire(statusKey, 86400);

        await client.hset(legacyKey, payload);
        await client.expire(legacyKey, 86400);
    } catch (err) {
        console.error(`[Redis] Failed to set finished status for submission ${submissionId}:`, err.message);
    }
}

module.exports = {
    getRedisClient,
    updateSubmissionTestStatus,
    setSubmissionJudging,
    setSubmissionFinished,
};
