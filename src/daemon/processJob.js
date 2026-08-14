const fs = require("fs-extra");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { LANGS, EXEC_MODE, SANDBOX_FLAGS } = require("./config");
const { runCommand } = require("./lib/runCommand");
const { ensureLanguageAvailable } = require("./lib/dockerImages");
const { ensureTestCasesCached } = require("./lib/testCache");
const { setSubmissionJudging, setSubmissionFinished } = require("./lib/redis");
const { runGrading } = require("./grading");

async function processJob(job) {
    const id = job.id || uuidv4();
    const match = String(id).match(/^sub-(\d+)-/);
    const submissionId = job.submission_id || (match ? match[1] : id);

    await setSubmissionJudging(submissionId, { status: "Judging" });

    const langKey = job.language;
    const version =
        job.version ||
        (LANGS[langKey] && LANGS[langKey].versions && LANGS[langKey].versions[0]);
    const lang = LANGS[langKey];
    if (!lang) {
        const res = { error: "unsupported language", status: "Judge Error" };
        await setSubmissionFinished(submissionId, res);
        return res;
    }

    const dockerImage = `${lang.dockerImage}:${version}`;

    // Checked FIRST, before writing anything to disk — a job for a
    // language/version this node doesn't have now fails fast with an
    // honest "Judge Error" instead of wasting a temp-dir write + compile
    // attempt, then falling through to docker run failing deep inside
    // executeAgainstTest where a nonzero exit code would previously have
    // been misclassified as "Runtime Error" on the user's own code.
    if (EXEC_MODE === "docker") {
        const { available, error } = await ensureLanguageAvailable(dockerImage);
        if (!available) {
            const res = {
                status: "Judge Error",
                error_message: `Language image not available on this judge node: ${dockerImage}${error ? ` (${error})` : ""}`,
            };
            await setSubmissionFinished(submissionId, res);
            return res;
        }
    }

    const tmpDir = path.join("/tmp", `submission-${id}`);
    await fs.remove(tmpDir);
    await fs.mkdirp(tmpDir);

    for (let [name, content] of Object.entries(job.files || {})) {
        if (content) {
            if (
                typeof content === "string" &&
                content.startsWith('"') &&
                content.endsWith('"')
            ) {
                try {
                    content = JSON.parse(content);
                } catch (e) {
                    content = content.slice(1, -1);
                }
            }
            await fs.writeFile(path.join(tmpDir, name), content);
        }
    }

    // Time limit conversion: if > 50, treat as milliseconds and convert to
    // seconds. NOTE: this magnitude-based guess is a stopgap, not a real
    // fix — it happens to work because 1000ms (1s, a very common default)
    // clears the threshold, but a genuinely-intended 45ms limit and a
    // genuinely-intended 45s limit are indistinguishable to this
    // heuristic. The durable fix is enforcing one canonical unit
    // (milliseconds, matching the problems.time_limit column) end-to-end
    // from GradeSubmissionJob.php through to here, rather than guessing
    // from the number's size.
    const rawTimeLimit = parseInt(job.time_limit, 10) || 1000;
    const timeLimit = rawTimeLimit > 50 ? Math.max(1, Math.ceil(rawTimeLimit / 1000)) : rawTimeLimit;
    const mem = parseInt(job.memory_limit, 10) || 256;

    if (lang.commandCompile) {
        let compileCmd = "";
        if (EXEC_MODE === "isolate") {
            compileCmd = `sh /app/src/sandbox/isolate_runner.sh compile ${mem} ${timeLimit} ${dockerImage} "${lang.commandCompile}" ${tmpDir}`;
        } else {
            compileCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${dockerImage} sh -c "${lang.commandCompile} 2>&1"`;
        }

        const compileRes = await runCommand(compileCmd, { maxBuffer: 10 * 1024 * 1024 });
        if (compileRes.code !== 0) {
            await fs.remove(tmpDir);
            const res = { status: "CE", error_message: compileRes.out, time: 0, memory: 0 };
            await setSubmissionFinished(submissionId, res);
            return res;
        }
    }

    let testCacheDir = null;
    try {
        testCacheDir = await ensureTestCasesCached(job.problem_id, job.test_cases_version);
    } catch (e) {
        await fs.remove(tmpDir);
        const res = { status: "Judge Error", error_message: `Failed to fetch test cases: ${e.message}` };
        await setSubmissionFinished(submissionId, res);
        return res;
    }

    const ctx = { tmpDir, dockerImage, mem, timeLimit, lang, id, submissionId, submission_id: submissionId, testCacheDir };
    let outcome;
    try {
        outcome = await runGrading(job, ctx);
    } catch (e) {
        await fs.remove(tmpDir);
        const res = { status: "Judge Error", error_message: `Grading failed: ${e.message}` };
        await setSubmissionFinished(submissionId, res);
        return res;
    }

    await setSubmissionFinished(submissionId, outcome);
    await fs.remove(tmpDir);
    return outcome;
}

module.exports = { processJob };