const fs = require("fs-extra");
const path = require("path");
const { runCommand } = require("./runCommand");
const { EXEC_MODE, SANDBOX_FLAGS } = require("../config");

// The gcc image used for compiling/running the checker — always C++ regardless
// of the submission's language, since checkers are always C++.
const CHECKER_IMAGE = "gcc:12";

/**
 * Compile the checker C++ source once per job.
 *
 * @param {string} checkerCode  - The full C++ source code of the checker.
 * @param {string} tmpDir       - Job's working directory (checker binary goes here).
 * @returns {{ ok: boolean, error?: string }}
 */
async function compileChecker(checkerCode, tmpDir) {
    const srcPath = path.join(tmpDir, "checker.cpp");
    const binPath = path.join(tmpDir, "checker");

    await fs.writeFile(srcPath, checkerCode, "utf8");

    let compileCmd;
    if (EXEC_MODE === "isolate") {
        // isolate mode: compile natively in the runner environment
        compileCmd = `g++ -O2 -o ${binPath} ${srcPath} 2>&1`;
    } else {
        compileCmd = `docker run --rm --network none --memory=256m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${CHECKER_IMAGE} sh -c "g++ -O2 -o /submission/checker /submission/checker.cpp 2>&1"`;
    }

    const result = await runCommand(compileCmd, { maxBuffer: 5 * 1024 * 1024 });
    if (result.code !== 0) {
        return { ok: false, error: `Checker compilation failed:\n${result.out}` };
    }

    return { ok: true };
}

/**
 * Run the compiled checker for one test case.
 *
 * The checker receives three file paths as arguments:
 *   argv[1] = input        (the test case input)
 *   argv[2] = output       (the submission's actual output)
 *   argv[3] = expected     (the reference / expected output)
 *
 * Exit code 0 → AC, any non-zero → WA.
 * The checker may write a message to stdout/stderr (captured as `checkerLog`).
 *
 * @param {string} tmpDir       - Job directory (checker binary + files live here).
 * @param {number} mem          - Memory limit in MB (reused for checker container).
 * @returns {{ verdict: "AC" | "WA", checkerLog: string }}
 */
async function runChecker(tmpDir, mem) {
    let checkerCmd;
    if (EXEC_MODE === "isolate") {
        checkerCmd = `${path.join(tmpDir, "checker")} /submission/input.txt /submission/output.txt /submission/expected.txt 2>&1`;
    } else {
        checkerCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${CHECKER_IMAGE} sh -c "/submission/checker /submission/input.txt /submission/output.txt /submission/expected.txt 2>&1; echo \\"exit:$?\\""`
    }

    const result = await runCommand(checkerCmd, { maxBuffer: 1 * 1024 * 1024 });

    // Parse exit code embedded in output
    const exitMatch = result.out.match(/exit:(\d+)$/m);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : result.code;
    const checkerLog = result.out.replace(/\nexit:\d+$/, "").trim();

    return {
        verdict: exitCode === 0 ? "OK" : "WA",
        checkerLog,
    };
}

module.exports = { compileChecker, runChecker };
