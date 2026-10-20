const { test } = require('node:test');
const assert = require('node:assert/strict');
let communicationCompiles = 0;
let communicationRuns = 0;
const batchRuns = [];
const result = (status) => ({ status, input: '', output: '', expected_output: '', time_used_ms: 5, memory_used_kb: 10 });
require.cache[require.resolve('../lib/redis')] = { exports: {
    setSubmissionJudging: async () => {}, setSubmissionFinished: async () => {}, updateSubmissionTestStatus: async () => {},
} };
require.cache[require.resolve('../lib/sandbox')] = { exports: {
    executeAgainstTest: async (_, test) => { batchRuns.push(test); return result(test.verdict); },
    toTestResult: (status) => result(status),
} };
require.cache[require.resolve('../grading/communication')] = { exports: {
    compileCommunicationBinaries: async () => { communicationCompiles++; return { code: 0 }; },
    executeCommunicationTest: async () => { communicationRuns++; return result('OK'); },
} };
const { runGrading } = require('../grading');

test('IOI Batch grading runs every test and only awards fully passing subtasks', async () => {
    const judged = await runGrading({ grading_type: 'IOI', task_type: 'Batch', subtasks: [
        { index: 0, points: 0, tests: [{ verdict: 'OK' }] },
        { index: 1, points: 30, tests: [{ verdict: 'WA' }, { verdict: 'OK' }] },
        { index: 2, points: 70, tests: [{ verdict: 'OK' }, { verdict: 'OK' }] },
    ] }, { id: 'batch-test' });
    assert.equal(judged.status, 70);
    assert.deepEqual(judged.subtasks.map((s) => s.points), [0, 0, 70]);
    assert.equal(batchRuns.length, 5);
    assert.equal(communicationCompiles, 0);
    assert.equal(communicationRuns, 0);
});

test('Communication tasks retain their manager-based compiler and executor', async () => {
    const judged = await runGrading({ grading_type: 'IOI', task_type: 'Communication', subtasks: [
        { index: 0, points: 100, tests: [{}] },
    ] }, { id: 'communication-test' });
    assert.equal(judged.status, 100);
    assert.equal(communicationCompiles, 1);
    assert.equal(communicationRuns, 1);
    assert.equal(batchRuns.length, 5);
});
