const fs = require("fs-extra");
const path = require("path");
const { runCommand } = require("./runCommand");
const { readTestFile } = require("./testCache");
const { updateSubmissionTestStatus } = require("./redis");
const { EXEC_MODE, SANDBOX_FLAGS } = require("../config");

function sanitizeText(str) {
    if (typeof str !== "string") return "";
    return str.trim();
}

function compareOutputs(actual, expected) {
    const actualTokens = actual.trim().split(/\s+/).filter(Boolean);
    const expectedTokens = expected.trim().split(/\s+/).filter(Boolean);

    if (actualTokens.length !== expectedTokens.length) return false;
    for (let i = 0; i < actualTokens.length; i++) {
        if (actualTokens[i] !== expectedTokens[i]) return false;
    }
    return true;
}

async function executeAgainstTest(ctx, test, testIndex) {
    if (!test) {
        throw new Error(`Test definition at index ${testIndex} is missing or undefined.`);
    }

    const { tmpDir, dockerImage, mem, timeLimit, id, testCacheDir, checkerReady, executeCmd } = ctx;

    const sanitizedInput = sanitizeText(
        await readTestFile(testCacheDir, test.input_file, test.input)
    );
    const sanitizedExpected = sanitizeText(
        await readTestFile(testCacheDir, test.expected_output_file, test.expected_output)
    );

    await fs.writeFile(path.join(tmpDir, "input.txt"), sanitizedInput);
    await fs.writeFile(path.join(tmpDir, "expected.txt"), sanitizedExpected);

    let execCmd;
    if (EXEC_MODE === "isolate") {
        execCmd = `sh /app/src/sandbox/isolate_runner.sh run ${mem} ${timeLimit} "${executeCmd}" ${tmpDir}`;
    } else {
        execCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${dockerImage} sh -c "/usr/bin/time -f '\\nTime: %e\\nMemory: %M' timeout ${timeLimit}s ${executeCmd} < /submission/input.txt 2>&1"`;
    }

    const execRes = await runCommand(execCmd, { maxBuffer: 20 * 1024 * 1024 });
    const outputStr = execRes.out;

    const m = outputStr.match(/\nTime: ([0-9.]+)\nMemory: ([0-9]+)/);
    const timeMs = m ? Math.floor(parseFloat(m[1]) * 1000) : 0;
    const memoryKb = m ? parseInt(m[2], 10) : 0;

    const filteredOutput = sanitizeText(
        outputStr.replace(/\nTime: [0-9.]+\nMemory: [0-9]+/, "")
    );

    let testVerdict = "OK";
    let checkerLog = null;

    if (execRes.code === 124) testVerdict = "TLE";
    else if (execRes.code === 137) testVerdict = "MLE";
    else if (execRes.code !== 0) testVerdict = "RE";

    if (testVerdict === "OK") {
        if (checkerReady) {
            await fs.writeFile(path.join(tmpDir, "output.txt"), filteredOutput);

            const { runChecker } = require("./checker");
            const checkerResult = await runChecker(tmpDir, mem);
            testVerdict = checkerResult.verdict;
            checkerLog = checkerResult.checkerLog || null;
        } else {
            if (!compareOutputs(filteredOutput, sanitizedExpected)) {
                testVerdict = "WA";
            }
        }
    }

    console.log(
        `[Worker] job ${id} test ${testIndex} → ${testVerdict} (Time: ${timeMs} ms, Memory: ${memoryKb} KB)${checkerLog ? ` [checker: ${checkerLog}]` : ""}`
    );

    const match = String(id).match(/^sub-(\d+)-/);
    const submissionId = ctx.submissionId || ctx.submission_id || (match ? match[1] : id);

    await updateSubmissionTestStatus(submissionId, {
        status: testVerdict,
        time: timeMs,
        memory: memoryKb,
        testIndex,
    });

    return { testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected };
}

function toTestResult(testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected) {
    return {
        status: testVerdict,
        input: sanitizedInput,
        output: filteredOutput,
        expected_output: sanitizedExpected,
        time_used_ms: timeMs,
        memory_used_kb: memoryKb,
        log: testVerdict,
    };
}

module.exports = { executeAgainstTest, toTestResult, sanitizeText, compareOutputs };