const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const { exec } = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

const LANG_FILE = path.resolve(__dirname, '../../config/languages.json');
const LANGS = JSON.parse(fs.readFileSync(LANG_FILE, 'utf8'));

const EXEC_MODE = process.env.EXEC_MODE || 'docker'; // 'docker' or 'isolate'
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(REDIS_URL);

function runCommand(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const code = err && typeof err.code === 'number' ? err.code : 0;
      resolve({ out: out.trim(), code });
    });
  });
}

async function processJob(job) {
  const id = job.id || uuidv4();
  const langKey = job.language;
  const version = job.version || (LANGS[langKey] && LANGS[langKey].versions && LANGS[langKey].versions[0]);
  const lang = LANGS[langKey];
  if (!lang) return { error: 'unsupported language' };

  const tmpDir = path.join('/tmp', `submission-${id}`);
  await fs.remove(tmpDir);
  await fs.mkdirp(tmpDir);

  // write files
  for (const [name, content] of Object.entries(job.files || {})) {
    await fs.writeFile(path.join(tmpDir, name), content);
  }
  await fs.writeFile(path.join(tmpDir, 'input.txt'), job.input || '');
  await fs.writeFile(path.join(tmpDir, 'expected.txt'), job.expected_output || '');

  const dockerImage = `${lang.dockerImage}:${version}`;
  const mem = job.memory_limit || 256; // MB
  const timeLimit = job.time_limit || 1; // seconds

  // Compile if needed
  if (lang.commandCompile) {
    if (EXEC_MODE === 'isolate') {
      // compile inside isolate wrapper
      const compileCmd = `sh /app/src/sandbox/isolate_runner.sh compile ${mem} ${timeLimit} ${dockerImage} \"${lang.commandCompile}\" ${tmpDir}`;
      const compileRes = await runCommand(compileCmd, { maxBuffer: 10 * 1024 * 1024 });
      if (compileRes.code !== 0) {
        await fs.writeFile(path.join(tmpDir, 'compile_output.txt'), compileRes.out);
        await fs.remove(tmpDir);
        return { status: 'CE', compile_output: compileRes.out };
      }
    } else {
      const compileCmd = `docker run --rm --network none --memory=${mem}m -v ${tmpDir}:/submission ${dockerImage} sh -c "${lang.commandCompile} 2>&1"`;
      const compileRes = await runCommand(compileCmd, { maxBuffer: 10 * 1024 * 1024 });
      if (compileRes.code !== 0) {
        await fs.writeFile(path.join(tmpDir, 'compile_output.txt'), compileRes.out);
        await fs.remove(tmpDir);
        return { status: 'CE', compile_output: compileRes.out };
      }
    }
  }

  // Execute
  let execRes;
  if (EXEC_MODE === 'isolate') {
    const execCmd = `sh /app/src/sandbox/isolate_runner.sh run ${mem} ${timeLimit} \"${lang.execute}\" ${tmpDir}`;
    execRes = await runCommand(execCmd, { maxBuffer: 20 * 1024 * 1024 });
  } else {
    const execCmd = `docker run --rm --network none --memory=${mem}m -v ${tmpDir}:/submission ${dockerImage} sh -c \"/usr/bin/time -f '\\nTime: %e\\nMemory: %M' timeout ${timeLimit}s ${lang.execute} < /submission/input.txt 2>&1\"`;
    execRes = await runCommand(execCmd, { maxBuffer: 20 * 1024 * 1024 });
  }

  const outputStr = execRes.out;

  // parse time & memory
  const m = outputStr.match(/\nTime: ([0-9.]+)\nMemory: ([0-9]+)/);
  const timeMs = m ? Math.floor(parseFloat(m[1]) * 1000) : null;
  const memoryKb = m ? parseInt(m[2], 10) : null;

  // remove time/memory lines from output
  const filteredOutput = outputStr.replace(/\nTime: [0-9.]+\nMemory: [0-9]+/, '').trim();

  // run simple checker (ignore trailing spaces and newlines)
  const submissionOutPath = path.join(tmpDir, 'submission_output.txt');
  await fs.writeFile(submissionOutPath, filteredOutput);

  const checkerCmd = `bash /app/src/checkers/check.sh /submission/submission_output.txt /submission/expected.txt`;
  const checkerRes = await runCommand(`docker run --rm --network none -v ${tmpDir}:/submission bash:5.2 sh -c "${checkerCmd}"`);

  const verdict = checkerRes.out.trim() === 'OK' ? 'OK' : 'WA';

  const result = {
    status: verdict,
    time_used_ms: timeMs,
    memory_used_kb: memoryKb,
    raw_output: filteredOutput,
    error_message: execRes.code === 124 ? 'TLE' : (execRes.code === 137 ? 'MLE/Killed' : null),
  };

  await fs.remove(tmpDir);
  return result;
}

app.post('/job', async (req, res) => {
  const job = req.body;
  const result = await processJob(job);
  return res.json(result);
});

// Redis queue listener
async function startRedisWorker() {
  try {
    console.log('Connecting to Redis at', REDIS_URL);
    while (true) {
      const payload = await redis.brpop('judge:jobs', 0); // [key, value]
      if (!payload) continue;
      const raw = payload[1];
      let job;
      try {
        job = JSON.parse(raw);
      } catch (e) {
        console.error('Invalid job payload from Redis');
        continue;
      }
      const result = await processJob(job);
      // push result to judge:results list for Laravel to read
      await redis.lpush('judge:results', JSON.stringify({ id: job.id || null, result }));
    }
  } catch (err) {
    console.error('Redis worker error', err);
    setTimeout(startRedisWorker, 3000);
  }
}

if (process.env.ENABLE_REDIS === '1') startRedisWorker();

app.listen(3001, () => console.log('Judge daemon listening on :3001'));
