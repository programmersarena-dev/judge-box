const fs = require('fs-extra');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LANGS, EXEC_MODE } = require('./config');
const { runCommand } = require('./lib/runCommand');
const { runDocker } = require('./lib/docker');
const { createWorkspace, safeFilePath } = require('./lib/workspace');
const { ensureLanguageAvailable } = require('./lib/dockerImages');
const { ensureTestCasesCached } = require('./lib/testCache');
const { runGrading } = require('./grading');
const { compileChecker } = require('./lib/checker');
const { resolveTaskType, prepareBatchGrader } = require('./lib/taskType');

async function processJob(job) {
  const id = String(job.id || randomUUID());
  const submissionId = job.submission_id || job.submissionId || id;
  const langKey = job.language;
  const lang = Object.hasOwn(LANGS, langKey) ? LANGS[langKey] : null;
  const version = String(job.version || lang?.versions?.[0] || '');
  if (!lang || !lang.versions?.map(String).includes(version)) {
    return { status: 'Judge Error', error_message: 'Unsupported language/version' };
  }
  const dockerImage = `${lang.dockerImage}:${version}`;
  if (EXEC_MODE === 'docker' || EXEC_MODE === 'isolate') {
    const { available } = await ensureLanguageAvailable(dockerImage);
    if (!available) return { _skip: true };
  }
  const tmpDir = await createWorkspace();
  try {
    for (const [name, content] of Object.entries(job.files || {})) {
      const filename = safeFilePath(tmpDir, name);
      if (typeof content !== 'string') throw new Error('Job files must contain text');
      if (content.length > 1024 * 1024) throw new Error('Job source file exceeds 1 MB');
      if (content) await fs.writeFile(filename, content);
    }
    const rawTimeLimit = Number(job.time_limit) || 1000;
    const timeLimit = job.time_limit_unit === 'ms' || rawTimeLimit > 50
      ? rawTimeLimit / 1000 : rawTimeLimit;
    const mem = Number(job.memory_limit) || 256;
    if (!(timeLimit > 0 && timeLimit <= 300) || !Number.isInteger(mem) || mem < 1 || mem > 65536) {
      throw new Error('Invalid execution limits');
    }
    const testCacheDir = await ensureTestCasesCached(job.problem_id, job.test_cases_version);
    const taskType = await resolveTaskType(job, testCacheDir);
    const compileCommand = taskType === 'Batch'
      ? await prepareBatchGrader(testCacheDir, tmpDir, lang, job.files || {}) : null;
    if (compileCommand) {
      const compileRes = EXEC_MODE === 'isolate'
        ? await runCommand('sh', ['/app/src/sandbox/isolate_runner.sh', 'compile', String(mem), '120', compileCommand, tmpDir], { timeout: 125000, maxBuffer: 10 * 1024 * 1024 })
        : await runDocker(dockerImage, tmpDir, mem, ['sh', '-c', `timeout 120s ${compileCommand} 2>&1`], {
          timeout: 125000, maxBuffer: 10 * 1024 * 1024,
          extraArgs: lang.buildCacheDir ? ['-v', `judge-${langKey}-cache:${lang.buildCacheDir}`] : [],
        });
      if (compileRes.code !== 0) return { status: 'CE', error_message: compileRes.out };
      const binaryPath = path.join(tmpDir, 'executable');
      if (await fs.pathExists(binaryPath)) await fs.chmod(binaryPath, 0o755);
    }
    let checkerReady = false;
    const jobFiles = job.files || {};
    const checkerFile = Object.keys(jobFiles).find((name) => ['checker.cpp', 'checker'].includes(name.toLowerCase()));
    if (checkerFile && jobFiles[checkerFile]) {
      const result = await compileChecker(jobFiles[checkerFile], tmpDir);
      if (!result.ok) return { status: 'Judge Error', error_message: result.error };
      checkerReady = true;
    }
    return await runGrading(job, { tmpDir, dockerImage, mem, timeLimit, lang, id, submissionId,
      testCacheDir, taskType, executeCmd: lang.execute, checkerReady, jobFiles });
  } finally {
    await fs.remove(tmpDir);
  }
}

module.exports = { processJob };
