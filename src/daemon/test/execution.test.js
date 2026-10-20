const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const { runCommand } = require('../lib/runCommand');
const { safeFilePath, createWorkspace } = require('../lib/workspace');
const { readTestFile } = require('../lib/testCache');

test('shell metacharacters are passed literally to the child', async () => {
  const argument = '$(echo injection); `id` & literal';
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument]);
  assert.equal(result.code, 0);
  assert.equal(result.out, argument);
});

test('reports missing executables, timeouts and output limits as failures', async () => {
  assert.notEqual((await runCommand('/arena/nonexistent', [])).code, 0);
  assert.equal((await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 })).code, 124);
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000))'], { maxBuffer: 100 });
  assert.equal(result.outputLimited, true);
  assert.notEqual(result.code, 0);
});

test('validates filenames and creates private unique workspaces', async () => {
  for (const name of ['../escape', '/tmp/escape', 'nested/file', 'x;id', '..']) {
    assert.throws(() => safeFilePath('/tmp/example', name));
  }
  const first = await createWorkspace();
  const second = await createWorkspace();
  try {
    assert.notEqual(first, second);
    assert.equal((await fs.stat(first)).mode & 0o777, 0o700);
    assert.equal(safeFilePath(first, 'submission.cpp'), path.join(first, 'submission.cpp'));
  } finally {
    await fs.remove(first);
    await fs.remove(second);
  }
});

test('reads cached inputs without changing whitespace and rejects traversal/symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-cache-test-'));
  try {
    const cache = path.join(root, 'cache');
    await fs.mkdirp(cache);
    await fs.writeFile(path.join(cache, '1.in'), '  42\n');
    await fs.writeFile(path.join(root, 'private'), 'secret');
    await fs.symlink(path.join(root, 'private'), path.join(cache, 'link'));
    assert.equal(await readTestFile(cache, '1.in'), '  42\n');
    await assert.rejects(readTestFile(cache, '../private'));
    await assert.rejects(readTestFile(cache, 'link'));
    await assert.rejects(readTestFile(null, '1.in'));
  } finally {
    await fs.remove(root);
  }
});
