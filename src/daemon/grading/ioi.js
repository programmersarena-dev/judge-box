const { executeAgainstTest, toTestResult } = require("../lib/sandbox");
const { compileCommunicationBinaries, executeCommunicationTest } = require("./communication");
const { IOI_TEST_CONCURRENCY } = require("../config");

// Runs an array of async test-jobs with at most `limit` in flight at
// once. limit=1 (the default) is fully sequential — identical to the
// prior behavior. Raising it trades judging throughput for timing
// accuracy; see the IOI_TEST_CONCURRENCY comment in config.js before
// changing it.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const current = nextIndex++;
    if (current >= items.length) return;
    results[current] = await worker(items[current], current);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// IOI: partial credit per subtask. Every test in a subtask runs to
// completion even after one fails (full diagnostic output for every
// test), but a subtask's points are all-or-nothing based on whether
// every one of its tests passed.
async function runIOI(job, ctx) {
  let totalPoints = 0;
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  const processedSubtasks = [];

  const isCommunication = (job.task_type || "Batch") === "Communication";

  if (isCommunication) {
    const compileRes = await compileCommunicationBinaries(ctx);
    if (compileRes.code !== 0) {
      return {
        status: "CE",
        max_time_used_ms: 0,
        max_memory_used_kb: 0,
        error_message: compileRes.out,
        subtasks: [],
      };
    }
  }

  const runOneTest = isCommunication ? executeCommunicationTest : executeAgainstTest;

  for (const subtask of job.subtasks || []) {
    const tests = subtask.tests || [];
    let isPassedSubtask = true;

    const testResults = await runWithConcurrency(tests, IOI_TEST_CONCURRENCY, async (test, testIndex) => {
      const { testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected } =
        await runOneTest(ctx, test, testIndex);

      maxTimeMs = Math.max(maxTimeMs, timeMs);
      maxMemoryKb = Math.max(maxMemoryKb, memoryKb);
      if (testVerdict !== "OK") isPassedSubtask = false;

      return toTestResult(testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected);
    });

    const subtaskPoints = isPassedSubtask ? subtask.points : 0;
    totalPoints += subtaskPoints;
    processedSubtasks.push({ index: subtask.index, points: subtaskPoints, tests: testResults });
  }

  return {
    status: totalPoints,
    max_time_used_ms: maxTimeMs,
    max_memory_used_kb: maxMemoryKb,
    error_message: null,
    subtasks: processedSubtasks,
  };
}

module.exports = { runIOI };