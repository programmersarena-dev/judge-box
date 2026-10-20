const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const { resolveTaskType, prepareBatchGrader } = require('../lib/taskType');

async function withBundle(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-task-type-'));
    try {
        await fs.mkdirp(path.join(root, 'graders'));
        await run(root);
    } finally {
        await fs.remove(root);
    }
}

test('a graders directory alone does not imply Communication', async () => {
    await withBundle(async (root) => {
        await fs.writeFile(path.join(root, 'graders/grader.cpp'), 'int main() {}');
        assert.equal(await resolveTaskType({}, root), 'Batch');
        await fs.writeJson(path.join(root, 'problem.json'), { task_type: 'Batch' });
        assert.equal(await resolveTaskType({}, root), 'Batch');
    });
});

test('task metadata takes precedence over legacy manager detection', async () => {
    await withBundle(async (root) => {
        await fs.writeFile(path.join(root, 'graders/manager.cpp'), 'int main() {}');
        assert.equal(await resolveTaskType({}, root), 'Communication');
        await fs.writeJson(path.join(root, 'problem.json'), { task_type: 'Batch' });
        assert.equal(await resolveTaskType({}, root), 'Batch');
        assert.equal(await resolveTaskType({ task_type: 'Communication' }, root), 'Communication');
        await fs.writeJson(path.join(root, 'problem.json'), { task_type: 'Communication' });
        assert.equal(await resolveTaskType({}, root), 'Communication');
        await assert.rejects(resolveTaskType({ task_type: 'unknown' }, root), /Unsupported task type/);
    });
});

test('batch preparation copies the grader and headers but preserves submitted source', async () => {
    await withBundle(async (root) => {
        const work = path.join(root, 'work');
        await fs.mkdirp(work);
        await fs.writeFile(path.join(root, 'graders/grader.cpp'), 'int main() {}');
        await fs.writeFile(path.join(root, 'graders/team.h'), 'int solve();');
        await fs.writeFile(path.join(root, 'graders/submission.cpp'), 'template');
        await fs.writeFile(path.join(work, 'submission.cpp'), 'contestant');
        const lang = { extension: 'cpp', commandCompile: 'plain compile', commandCompileGrader: 'grader compile' };
        assert.equal(await prepareBatchGrader(root, work, lang, { 'submission.cpp': 'contestant' }), 'grader compile');
        assert.equal(await fs.readFile(path.join(work, 'submission.cpp'), 'utf8'), 'contestant');
        assert.equal(await fs.readFile(path.join(work, 'team.h'), 'utf8'), 'int solve();');
        assert.equal(await fs.pathExists(path.join(work, 'grader.cpp')), true);
        assert.equal(await prepareBatchGrader(null, work, lang, {}), 'plain compile');
        await assert.rejects(prepareBatchGrader(root, work, { extension: 'py' }, {}), /configured C\+\+ grader/);
        await fs.remove(path.join(root, 'graders/grader.cpp'));
        await assert.rejects(prepareBatchGrader(root, work, lang, {}), /missing graders\/grader.cpp/);
    });
});
