const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const { createWorkspace } = require('../lib/workspace');
const { runDocker } = require('../lib/docker');

// Integration tests never connect to the application's Redis instance.
require.cache[require.resolve('../lib/redis')] = { exports: {
  updateSubmissionTestStatus: async () => {}, setSubmissionJudging: async () => {}, setSubmissionFinished: async () => {},
} };
const { executeAgainstTest } = require('../lib/sandbox');
const { compileChecker, runChecker } = require('../lib/checker');
let fixtureBundle;
require('../lib/testCache').ensureTestCasesCached = async () => fixtureBundle;
const { processJob } = require('../processJob');

test('real Docker grading isolates concurrent inputs and keeps answers outside the sandbox', {
  skip: process.env.ARENA_DOCKER_TESTS !== '1',
}, async () => {
  const directory = await createWorkspace();
  try {
    await fs.writeFile(path.join(directory, 'submission.cpp'), `
      #include <iostream>
      #include <fstream>
      int main() {
        long n; std::cin >> n;
        if (std::ifstream("/submission/expected.txt").good()) std::cout << "leaked";
        else std::cout << n * 2;
      }
    `);
    const image = process.env.ARENA_TEST_IMAGE || 'gcc:10';
    const compilation = await runDocker(image, directory, 256,
      ['g++', '/submission/submission.cpp', '-o', '/submission/executable'], { timeout: 30000 });
    assert.equal(compilation.code, 0, compilation.out);
    const context = { tmpDir: directory, dockerImage: image, mem: 256, timeLimit: 1.5,
      id: 'test', executeCmd: '/submission/executable', checkerReady: false };
    const results = await Promise.all([
      executeAgainstTest(context, { input: '21\n', expected_output: '42\n' }, 0),
      executeAgainstTest(context, { input: '5\n', expected_output: '10\n' }, 1),
    ]);
    assert.deepEqual(results.map((result) => result.status), ['OK', 'OK']);
    assert.equal(results[0].input, '21\n');
    assert.equal(await fs.pathExists(path.join(directory, 'input.txt')), false);
  } finally {
    await fs.remove(directory);
  }
});

test('real Docker checker preserves rejection and reports missing binaries as judge failures', {
  skip: process.env.ARENA_DOCKER_TESTS !== '1',
}, async () => {
  const directory = await createWorkspace();
  try {
    const compilation = await compileChecker(`
      #include <fstream>
      int main(int argc, char** argv) {
        long actual, expected;
        if (argc != 4 || !(std::ifstream(argv[2]) >> actual) || !(std::ifstream(argv[3]) >> expected)) return 2;
        return actual == expected ? 0 : 1;
      }
    `, directory);
    assert.equal(compilation.ok, true, compilation.error);
    await fs.writeFile(path.join(directory, 'input.txt'), '21\n');
    await fs.writeFile(path.join(directory, 'expected.txt'), '42\n');
    await fs.writeFile(path.join(directory, 'output.txt'), '7\n');
    const rejection = await runChecker(directory, 256);
    assert.equal(rejection.verdict, 'WA', rejection.checkerLog);
    await fs.writeFile(path.join(directory, 'output.txt'), '42\n');
    const acceptance = await runChecker(directory, 256);
    assert.equal(acceptance.verdict, 'OK', acceptance.checkerLog);
    await fs.remove(path.join(directory, 'checker'));
    assert.equal((await runChecker(directory, 256)).verdict, 'Judge Error');
  } finally {
    await fs.remove(directory);
  }
});

test('real IOI Batch jobs link a function-only submission with the supplied grader', {
  skip: process.env.ARENA_DOCKER_TESTS !== '1',
}, async () => {
  fixtureBundle = await createWorkspace();
  try {
    await fs.mkdirp(path.join(fixtureBundle, 'graders'));
    await fs.writeJson(path.join(fixtureBundle, 'problem.json'), { task_type: 'Batch' });
    await fs.writeFile(path.join(fixtureBundle, 'graders/task.h'), 'int solve(int value);');
    await fs.writeFile(path.join(fixtureBundle, 'graders/grader.cpp'), `
      #include "task.h"
      #include <iostream>
      int main() { int n; std::cin >> n; std::cout << solve(n); }
    `);
    const job = {
      id: 'batch-regression', language: 'gcc', version: '10', grading_type: 'IOI',
      files: { 'submission.cpp': '#include "task.h"\nint solve(int value) { return value * 2; }' },
      time_limit: 1000, time_limit_unit: 'ms', memory_limit: 256,
      subtasks: [
        { index: 0, points: 0, tests: [{ input: '1\n', expected_output: '2\n' }] },
        { index: 1, points: 30, tests: [{ input: '2\n', expected_output: '5\n' }] },
        { index: 2, points: 70, tests: [{ input: '3\n', expected_output: '6\n' }] },
      ],
    };
    const partial = await processJob(job);
    assert.equal(partial.status, 70, partial.error_message);
    assert.deepEqual(partial.subtasks.map((s) => s.tests[0].status), ['OK', 'WA', 'OK']);
    job.subtasks[1].tests[0].expected_output = '4\n';
    const full = await processJob(job);
    assert.equal(full.status, 100, full.error_message);
    assert.deepEqual(full.subtasks.map((s) => s.points), [0, 30, 70]);
  } finally {
    await fs.remove(fixtureBundle);
    fixtureBundle = null;
  }
});
