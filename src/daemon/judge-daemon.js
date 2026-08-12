const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs-extra");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");
const os = require("os");
const axios = require("axios");
const extractZip = require("extract-zip");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

const LANG_FILE = path.resolve(__dirname, "../../config/languages.json");
const LANGS = JSON.parse(fs.readFileSync(LANG_FILE, "utf8"));

const EXEC_MODE = process.env.EXEC_MODE || "docker"; // 'docker' or 'isolate'
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = new Redis(REDIS_URL, {
  keyPrefix: process.env.REDIS_PREFIX || "",
});

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const IN_PROGRESS_KEY = `judge:jobs:in-progress:${WORKER_ID}`;
const PROCESSING_HASH = "judge:jobs:processing_at";

const CACHE_ROOT = process.env.JUDGE_TEST_CACHE_DIR || "/var/cache/judge/tests";

// Automatically formats missing http:// or missing colons in URL
function formatBaseUrl(urlStr) {
  if (!urlStr) return "http://127.0.0.1:8000";
  let url = urlStr.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`;
  }
  // Auto-insert colon if missing between host and port (e.g. localhost8001 -> localhost:8001)
  url = url.replace(/(localhost|127\.0\.0\.1)(\d{4,5})/i, "$1:$2");
  return url.replace(/\/+$/, "");
}

const LARAVEL_INTERNAL_URL = formatBaseUrl(process.env.LARAVEL_INTERNAL_URL);
const JUDGE_SECRET_TOKEN = process.env.JUDGE_SECRET_TOKEN;

async function ensureTestCasesCached(problemId, version) {
  if (!problemId || !version) return null;

  const cacheDir = path.join(CACHE_ROOT, `${problemId}-${version}`);
  if (await fs.pathExists(cacheDir)) {
    return cacheDir;
  }

  await fs.mkdirp(CACHE_ROOT);
  const zipPath = path.join(CACHE_ROOT, `${problemId}-${version}.zip`);

  const downloadUrl = `${LARAVEL_INTERNAL_URL}/internal/test-cases/${problemId}`;
  console.log(`[Worker] Downloading test bundle from: ${downloadUrl}`);

  const response = await axios.get(
    downloadUrl,
    { headers: { "X-Judge-Token": JUDGE_SECRET_TOKEN }, responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  await fs.mkdirp(cacheDir);
  await extractZip(zipPath, { dir: cacheDir });
  await fs.remove(zipPath);

  return cacheDir;
}

async function readTestFile(cacheDir, relativeFile, inlineFallback) {
  if (relativeFile && cacheDir) {
    return fs.readFile(path.join(cacheDir, relativeFile), "utf8");
  }
  return inlineFallback || "";
}

// --- helpers -------------------------------------------------------------

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

function runCommand(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr || "");
      const code = err && typeof err.code === "number" ? err.code : 0;
      resolve({ out: out.trim(), code });
    });
  });
}

const SANDBOX_FLAGS =
  "--pids-limit 64 --cpus 1 --cap-drop=ALL --security-opt no-new-privileges --user 1000:1000";

async function executeAgainstTest(ctx, test, testIndex) {
  if (!test) {
    throw new Error(`Test definition at index ${testIndex} is missing or undefined.`);
  }

  const { tmpDir, dockerImage, mem, timeLimit, lang, id, testCacheDir } = ctx;

  const sanitizedInput = sanitizeText(
    await readTestFile(testCacheDir, test.input_file, test.input)
  );
  const sanitizedExpected = sanitizeText(
    await readTestFile(testCacheDir, test.expected_output_file, test.expected_output)
  );

  await fs.writeFile(path.join(tmpDir, "input.txt"), sanitizedInput);

  let execCmd;
  if (EXEC_MODE === "isolate") {
    execCmd = `sh /app/src/sandbox/isolate_runner.sh run ${mem} ${timeLimit} "${lang.execute}" ${tmpDir}`;
  } else {
    execCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${dockerImage} sh -c "/usr/bin/time -f '\\nTime: %e\\nMemory: %M' timeout ${timeLimit}s ${lang.execute} < /submission/input.txt 2>&1"`;
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
  if (execRes.code === 124) testVerdict = "TLE";
  else if (execRes.code === 137) testVerdict = "MLE";
  else if (execRes.code !== 0) testVerdict = "RE";

  if (testVerdict === "OK" && !compareOutputs(filteredOutput, sanitizedExpected)) {
    testVerdict = "WA";
  }

  console.log(
    `[Worker] job ${id} test ${testIndex} → ${testVerdict} (Time: ${timeMs} ms, Memory: ${memoryKb} KB)`
  );

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

// --- grading types ---------------------------------------------------------

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

async function runICPC(job, ctx) {
  return runClassic(job, ctx);
}

async function runIOI(job, ctx) {
  let totalPoints = 0;
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  const processedSubtasks = [];

  for (const subtask of job.subtasks || []) {
    const testResults = [];
    let isPassedSubtask = true;
    const tests = subtask.tests || [];

    for (const [testIndex, test] of tests.entries()) {
      const { testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected } =
        await executeAgainstTest(ctx, test, testIndex);

      maxTimeMs = Math.max(maxTimeMs, timeMs);
      maxMemoryKb = Math.max(maxMemoryKb, memoryKb);
      if (testVerdict !== "OK") isPassedSubtask = false;

      testResults.push(
        toTestResult(testVerdict, timeMs, memoryKb, filteredOutput, sanitizedInput, sanitizedExpected)
      );
    }

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

// --- main job pipeline -----------------------------------------------------

async function processJob(job) {
  const id = job.id || uuidv4();
  const langKey = job.language;
  const version =
    job.version ||
    (LANGS[langKey] && LANGS[langKey].versions && LANGS[langKey].versions[0]);
  const lang = LANGS[langKey];
  if (!lang) return { error: "unsupported language" };

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

  const dockerImage = `${lang.dockerImage}:${version}`;

  // Time limit conversion: if > 50, convert ms to seconds
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
      return { status: "CE", error_message: compileRes.out };
    }
  }

  let testCacheDir = null;
  try {
    testCacheDir = await ensureTestCasesCached(job.problem_id, job.test_cases_version);
  } catch (e) {
    await fs.remove(tmpDir);
    return { status: "Judge Error", error_message: `Failed to fetch test cases: ${e.message}` };
  }

  const ctx = { tmpDir, dockerImage, mem, timeLimit, lang, id, testCacheDir };
  const gradingType = (job.grading_type || "Standard").toUpperCase();

  let outcome;
  if (gradingType === "IOI") {
    outcome = await runIOI(job, ctx);
  } else if (gradingType === "ICPC") {
    outcome = await runICPC(job, ctx);
  } else {
    outcome = await runClassic(job, ctx);
  }

  await fs.remove(tmpDir);
  return outcome;
}

app.post("/job", async (req, res) => {
  const job = req.body;
  const result = await processJob(job);
  return res.json(result);
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// --- Redis queue listener (reliable dequeue) --------------------------

async function startRedisWorker() {
  try {
    const queueName = "judge:jobs";
    console.log(`[${WORKER_ID}] Listening on queue: ${queueName}`);

    while (true) {
      const raw = await redis.brpoplpush(queueName, IN_PROGRESS_KEY, 0);
      if (!raw) continue;

      let job;
      try {
        job = JSON.parse(raw);
      } catch (e) {
        console.error("Invalid job payload from Redis");
        await redis.lrem(IN_PROGRESS_KEY, 1, raw);
        continue;
      }

      await redis.hset(PROCESSING_HASH, job.id, Date.now());

      let result;
      try {
        result = await processJob(job);
      } catch (e) {
        console.error(`[${WORKER_ID}] processJob threw for ${job.id}:`, e);
        result = { status: "Judge Error", error_message: String(e) };
      }

      await redis.lpush("judge:results", JSON.stringify({ id: job.id || null, result }));

      await redis.lrem(IN_PROGRESS_KEY, 1, raw);
      await redis.hdel(PROCESSING_HASH, job.id);
    }
  } catch (err) {
    console.error("Redis worker error", err);
    setTimeout(startRedisWorker, 3000);
  }
}

if (process.env.ENABLE_REDIS === "1") startRedisWorker();

app.listen(3001, () => console.log("Judge daemon listening on :3001"));