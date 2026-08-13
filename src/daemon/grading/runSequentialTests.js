const { executeAgainstTest, toTestResult } = require("../lib/sandbox");

// Shared engine for grading types that run tests in order and stop at
// the first failure (Classic, ICPC) — no partial credit, single binary
// outcome for the whole problem.
async function runSequentialTests(tests, ctx) {
    const testResults = [];
    let maxTimeMs = 0;
    let maxMemoryKb = 0;
    let verdict = "OK";

    for (const [testIndex, test] of tests.entries()) {
        const { testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected } =
            await executeAgainstTest(ctx, test, testIndex);

        maxTimeMs = Math.max(maxTimeMs, timeMs);
        maxMemoryKb = Math.max(maxMemoryKb, memoryKb);
        testResults.push(
            toTestResult(testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected)
        );

        verdict = testVerdict;
        if (testVerdict !== "OK") break;
    }

    return { verdict, maxTimeMs, maxMemoryKb, testResults };
}

module.exports = { runSequentialTests };