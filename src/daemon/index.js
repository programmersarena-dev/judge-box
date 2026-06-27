const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs-extra");
const { exec } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

const LANG_FILE = path.resolve(__dirname, "../../config/languages.json");
const LANGS = JSON.parse(fs.readFileSync(LANG_FILE, "utf8"));

const EXEC_MODE = process.env.EXEC_MODE || "docker"; // 'docker' or 'isolate'
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = new Redis(REDIS_URL, {
  keyPrefix: "programmersarena_database_",
});

function runCommand(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr || "");
      const code = err && typeof err.code === "number" ? err.code : 0;
      resolve({ out: out.trim(), code });
    });
  });
}

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

  // 1. Write the source files and grader files
  for (let [name, content] of Object.entries(job.files || {})) {
    if (content) {
      // Check if the string is wrapped in literal escaped quotes due to double-serialization
      if (
        typeof content === "string" &&
        content.startsWith('"') &&
        content.endsWith('"')
      ) {
        try {
          // Safely unwrap the string
          content = JSON.parse(content);
        } catch (e) {
          // Fallback fallback if it's a structural anomaly
          content = content.slice(1, -1);
        }
      }
      await fs.writeFile(path.join(tmpDir, name), content);
    }
  }

  const dockerImage = `${lang.dockerImage}:${version}`;
  const mem = job.memory_limit || 256; // MB
  const timeLimit = job.time_limit || 1; // seconds

  // 2. Compile Phase (Executed ONCE per submission)
  if (lang.commandCompile) {
    let compileCmd = "";
    if (EXEC_MODE === "isolate") {
      compileCmd = `sh /app/src/sandbox/isolate_runner.sh compile ${mem} ${timeLimit} ${dockerImage} "${lang.commandCompile}" ${tmpDir}`;
    } else {
      compileCmd = `docker run --rm --network none --memory=${mem}m -v ${tmpDir}:/submission ${dockerImage} sh -c "${lang.commandCompile} 2>&1"`;
    }

    const compileRes = await runCommand(compileCmd, {
      maxBuffer: 10 * 1024 * 1024,
    });
    if (compileRes.code !== 0) {
      await fs.remove(tmpDir);
      return { status: "CE", error_message: compileRes.out };
    }
  }

  // Track global submission resource metrics
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  const processedSubtasks = [];

  // 3. Execution Phase (Loop through nested Subtasks and Test cases)
  const subtasks = job.subtasks || [];

  for (const subtask of subtasks) {
    const testResults = [];

    for (const [testIndex, test] of subtask.tests.entries()) {
      // Setup isolated inputs for current test case run
      await fs.writeFile(path.join(tmpDir, "input.txt"), test.input || "");
      await fs.writeFile(
        path.join(tmpDir, "expected.txt"),
        test.expected_output || ""
      );

      let execCmd = "";
      if (EXEC_MODE === "isolate") {
        execCmd = `sh /app/src/sandbox/isolate_runner.sh run ${mem} ${timeLimit} "${lang.execute}" ${tmpDir}`;
      } else {
        execCmd = `docker run --rm --network none --memory=${mem}m -v ${tmpDir}:/submission ${dockerImage} sh -c "/usr/bin/time -f '\\nTime: %e\\nMemory: %M' timeout ${timeLimit}s ${lang.execute} < /submission/input.txt 2>&1"`;
      }

      const execRes = await runCommand(execCmd, {
        maxBuffer: 20 * 1024 * 1024,
      });
      const outputStr = execRes.out;

      // Extract performance data
      const m = outputStr.match(/\nTime: ([0-9.]+)\nMemory: ([0-9]+)/);
      const timeMs = m ? Math.floor(parseFloat(m[1]) * 1000) : 0;
      const memoryKb = m ? parseInt(m[2], 10) : 0;

      if (timeMs > maxTimeMs) maxTimeMs = timeMs;
      if (memoryKb > maxMemoryKb) maxMemoryKb = memoryKb;

      const filteredOutput = outputStr
        .replace(/\nTime: [0-9.]+\nMemory: [0-9]+/, "")
        .trim();
      let testVerdict = "OK";

      // Determine initial runtime errors
      if (execRes.code === 124) {
        testVerdict = "TLE";
      } else if (execRes.code === 137) {
        testVerdict = "MLE";
      } else if (execRes.code !== 0) {
        testVerdict = "RE";
      }

      // If execution was successful, evaluate using standard check engine
      if (testVerdict === "OK") {
        const submissionOutPath = path.join(tmpDir, "submission_output.txt");
        await fs.writeFile(submissionOutPath, filteredOutput);

        const checkerCmd = `bash /app/src/checkers/check.sh /submission/submission_output.txt /submission/expected.txt`;
        const checkerRes = await runCommand(
          `docker run --rm --network none -v ${tmpDir}:/submission bash:5.2 sh -c "${checkerCmd}"`
        );

        if (checkerRes.out.trim() !== "OK") {
          testVerdict = "WA";
        }
      }

      testResults.push({
        status: testVerdict,
        time_used_ms: timeMs,
        memory_used_kb: memoryKb,
        log: testVerdict, // compatibility flag for old checker arrays
      });
    }

    processedSubtasks.push({
      index: subtask.index,
      points: subtask.points,
      tests: testResults,
    });
  }

  await fs.remove(tmpDir);

  // Return formatted response object mapped perfectly to Laravel consumption definitions
  return {
    status: "Judged",
    max_time_used_ms: maxTimeMs,
    max_memory_used_kb: maxMemoryKb,
    error_message: null,
    subtasks: processedSubtasks,
  };
}

app.post("/job", async (req, res) => {
  const job = req.body;
  const result = await processJob(job);
  return res.json(result);
});

// Redis queue listener
async function startRedisWorker() {
  try {
    // Aligned to normalized queue keys defined in Laravel jobs
    const queueName = "judge:jobs";
    console.log(`Connecting to Redis. Listening on queue: ${queueName}`);

    while (true) {
      const payload = await redis.brpop(queueName, 0);
      if (!payload) continue;

      const raw = payload[1];
      let job;
      try {
        job = JSON.parse(raw);
      } catch (e) {
        console.error("Invalid job payload from Redis");
        continue;
      }

      const result = await processJob(job);

      // Push payload result matrix back to Laravel's queue worker consumer
      await redis.lpush(
        "judge:results",
        JSON.stringify({ id: job.id || null, result })
      );
    }
  } catch (err) {
    console.error("Redis worker error", err);
    setTimeout(startRedisWorker, 3000);
  }
}

if (process.env.ENABLE_REDIS === "1") startRedisWorker();

app.listen(3001, () => console.log("Judge daemon listening on :3001"));
