const { executeAgainstTest, toTestResult } = require("../lib/sandbox");
const { compileCommunicationBinaries, executeCommunicationTest } = require("./communication");
const { IOI_TEST_CONCURRENCY } = require("../config");
const { setSubmissionJudging, setSubmissionFinished, updateSubmissionTestStatus } = require("../lib/redis");
const fs = require("fs-extra");
const path = require("path");

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

async function runIOI(job, ctx) {
  const submissionId = ctx.submissionId || ctx.submission_id || ctx.id;
  await setSubmissionJudging(submissionId, { status: "Judging" });

  let totalPoints = 0;
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  const processedSubtasks = [];

  const isCommunication = (job.task_type || "Batch") === "Communication"
    || (ctx.testCacheDir && fs.existsSync(path.join(ctx.testCacheDir, "graders")));

  if (isCommunication) {
    const compileRes = await compileCommunicationBinaries(ctx);
    if (compileRes.code !== 0) {
      const result = {
        status: "CE",
        max_time_used_ms: 0,
        max_memory_used_kb: 0,
        error_message: compileRes.out,
        subtasks: [],
        score: 0,
      };
      await setSubmissionFinished(submissionId, result);
      return result;
    }
  }

  const runOneTest = isCommunication ? executeCommunicationTest : executeAgainstTest;

  for (const subtask of job.subtasks || []) {
    const tests = subtask.tests || [];
    let isPassedSubtask = true;

    await updateSubmissionTestStatus(submissionId, {
      status: "Judging",
      subtask: subtask.index + 1,
    });

    const testResults = await runWithConcurrency(tests, IOI_TEST_CONCURRENCY, async (test, testIndex) => {
      await updateSubmissionTestStatus(submissionId, {
        status: "Judging",
        testIndex,
        subtask: subtask.index + 1,
      });

      try {
        const { status, time_used_ms, memory_used_kb, input, output, expected_output } =
          await runOneTest(ctx, test, testIndex);

        maxTimeMs = Math.max(maxTimeMs, time_used_ms);
        maxMemoryKb = Math.max(maxMemoryKb, memory_used_kb);
        if (status !== "OK") isPassedSubtask = false;

        return { status, input, output, expected_output, time_used_ms, memory_used_kb, log: status };
      } catch (err) {
        isPassedSubtask = false;
        return { status: "Judge Error", input: "", output: "", expected_output: "", time_used_ms: 0, memory_used_kb: 0, log: "Judge Error" };
      }
    });

    const subtaskPoints = isPassedSubtask ? subtask.points : 0;
    totalPoints += subtaskPoints;
    processedSubtasks.push({ index: subtask.index, points: subtaskPoints, tests: testResults });
  }

  const result = {
    status: totalPoints,
    score: totalPoints,
    max_time_used_ms: maxTimeMs,
    max_memory_used_kb: maxMemoryKb,
    error_message: null,
    subtasks: processedSubtasks,
  };

  await setSubmissionFinished(submissionId, result);
  return result;
}

module.exports = { runIOI };
