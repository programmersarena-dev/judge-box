const { executeAgainstTest, toTestResult } = require("../lib/sandbox");

// Shared engine for grading types that run tests in order and stop at
// the first failure (Classic, ICPC) — no partial credit, single binary
// outcome for the whole problem.
async function runSequentialTests(tests, ctx) {
    const testResults = [];
    let maxTimeMs = 0;
    let maxMemoryKb = 0;
    let verdict = "AC";

    for (const [testIndex, test] of tests.entries()) {
        const { status, time_used_ms, memory_used_kb, input, output, expected_output } =
            await executeAgainstTest(ctx, test, testIndex);

        maxTimeMs = Math.max(maxTimeMs, time_used_ms);
        maxMemoryKb = Math.max(maxMemoryKb, memory_used_kb);
        testResults.push(
            toTestResult(status, time_used_ms, memory_used_kb, output, input, expected_output)
        );

        verdict = status;
        if (status !== "AC" && status !== "OK") break;
    }

    return { verdict: (verdict === "OK" ? "AC" : verdict), maxTimeMs, maxMemoryKb, testResults };
}

module.exports = { runSequentialTests };