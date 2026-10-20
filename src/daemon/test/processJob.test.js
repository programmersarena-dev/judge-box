const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const images = require('../lib/dockerImages');
const cache = require('../lib/testCache');
const grading = require('../grading');

images.ensureLanguageAvailable = async () => ({ available: true });
cache.ensureTestCasesCached = async () => null;
let usedDirectory;
grading.runGrading = async (_, context) => {
  usedDirectory = context.tmpDir;
  throw new Error('grading failed');
};
const { processJob } = require('../processJob');

test('removes its workspace when grading throws', async () => {
  await assert.rejects(processJob({ language: 'python', version: '3.10', files: { 'submission.py': 'print(42)' } }), /grading failed/);
  assert.equal(await fs.pathExists(usedDirectory), false);
});

test('rejects unsupported versions before starting a command', async () => {
  const result = await processJob({ language: 'gcc', version: '10;id', files: {} });
  assert.equal(result.status, 'Judge Error');
});

test('rejects path traversal filenames', async () => {
  await assert.rejects(processJob({ language: 'python', version: '3.10', files: { '../escape': 'bad' } }), /Invalid job filename/);
});
