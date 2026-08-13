const { runSequentialTests } = require("./runSequentialTests");

// Classic (a.k.a. "Standard"): one problem, one pass/fail verdict, stops
// at the first failing test.
async function runClassic(job, ctx) {
    const tests = (job.subtasks || []).flatMap((st) => st.tests || []);

    if (tests.length === 0) {
        return {
            status: "System Error",
            max_time_used_ms: 0,
            max_memory_used_kb: 0,
            error_message: "No test cases found for this job.",
            subtasks: [],
        };
    }

    const { verdict, maxTimeMs, maxMemoryKb, testResults } = await runSequentialTests(tests, ctx);

    return {
        status: verdict === "OK" ? "AC" : verdict,
        max_time_used_ms: maxTimeMs,
        max_memory_used_kb: maxMemoryKb,
        error_message: null,
        subtasks: [
            {
                index: 0,
                points: verdict === "OK" ? job.subtasks?.[0]?.points ?? 100 : 0,
                tests: testResults,
            },
        ],
    };
}

module.exports = { runClassic };