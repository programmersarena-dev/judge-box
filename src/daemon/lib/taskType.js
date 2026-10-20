const fs = require('fs-extra');
const path = require('node:path');
const { readTestFile } = require('./testCache');

async function resolveTaskType(job, testCacheDir) {
    let taskType = job.task_type;
    if (!taskType && testCacheDir && await fs.pathExists(path.join(testCacheDir, 'problem.json'))) {
        const metadata = JSON.parse(await readTestFile(testCacheDir, 'problem.json'));
        taskType = metadata.task_type;
    }
    // Older bundles may lack metadata. A manager, not merely a graders folder,
    // identifies the existing communication protocol.
    if (!taskType) {
        taskType = testCacheDir && await fs.pathExists(path.join(testCacheDir, 'graders', 'manager.cpp'))
            ? 'Communication' : 'Batch';
    }
    if (!['Batch', 'Communication'].includes(taskType)) {
        throw new Error(`Unsupported task type: ${taskType}`);
    }
    return taskType;
}

async function prepareBatchGrader(testCacheDir, tmpDir, lang, jobFiles) {
    if (!testCacheDir || !await fs.pathExists(path.join(testCacheDir, 'graders'))) {
        return lang.commandCompile;
    }
    const graderDir = path.join(testCacheDir, 'graders');
    if (lang.extension !== 'cpp' || !lang.commandCompileGrader) {
        throw new Error('This Batch grader requires a configured C++ grader compiler.');
    }
    if (!await fs.pathExists(path.join(graderDir, 'grader.cpp'))) {
        throw new Error('Batch bundle is missing graders/grader.cpp.');
    }
    await fs.copy(graderDir, tmpDir, {
        // A bundle can ship contestant templates. Never overwrite submitted code.
        filter: (source) => source === graderDir || !Object.hasOwn(jobFiles, path.relative(graderDir, source)),
    });
    return lang.commandCompileGrader;
}

module.exports = { resolveTaskType, prepareBatchGrader };
