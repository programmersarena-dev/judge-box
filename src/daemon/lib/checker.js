const fs = require("fs-extra");
const path = require("path");
const { runCommand } = require("./runCommand");
const { EXEC_MODE, LANGS } = require("../config");
const { runDocker } = require('./docker');

// The gcc image used for compiling/running the checker — always C++ regardless
// of the submission's language, since checkers are always C++.
const CHECKER_IMAGE = `${LANGS.gcc?.dockerImage || 'gcc'}:${LANGS.gcc?.versions?.[0] || '12'}`;

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

    let result;
    if (EXEC_MODE === "isolate") {
        // isolate mode: compile natively in the runner environment
        result = await runCommand('g++', ['-O2', '-o', binPath, srcPath], { timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
    } else {
        result = await runDocker(CHECKER_IMAGE, tmpDir, 256, ['g++', '-O2', '-o', '/submission/checker', '/submission/checker.cpp'], { timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
    }

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
 * Exit code 0 → OK; checker rejection → WA; sandbox failures → Judge Error.
 * The checker may write a message to stdout/stderr (captured as `checkerLog`).
 *
 * @param {string} tmpDir       - Job directory (checker binary + files live here).
 * @param {number} mem          - Memory limit in MB (reused for checker container).
 * @returns {{ verdict: "OK" | "WA" | "Judge Error", checkerLog: string }}
 */
async function runChecker(tmpDir, mem) {
    let result;
    if (EXEC_MODE === "isolate") {
        result = await runCommand(path.join(tmpDir, 'checker'), ['input.txt', 'output.txt', 'expected.txt'], { cwd: tmpDir, timeout: 10000, maxBuffer: 1024 * 1024 });
    } else {
        result = await runDocker(CHECKER_IMAGE, tmpDir, mem, ['/submission/checker', '/submission/input.txt', '/submission/output.txt', '/submission/expected.txt'], { timeout: 10000, maxBuffer: 1024 * 1024 });
    }

    return {
        verdict: result.code === 0 ? 'OK' : result.timedOut || result.outputLimited || result.code >= 125 ? 'Judge Error' : 'WA',
        checkerLog: result.out,
    };
}

module.exports = { compileChecker, runChecker };
