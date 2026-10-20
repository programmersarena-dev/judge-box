const { runClassic } = require("./classic");
const { runICPC } = require("./icpc");
const { runIOI } = require("./ioi");
const { resolveTaskType } = require('../lib/taskType');

async function runGrading(job, ctx) {
    const gradingType = (job.grading_type || "Standard").toUpperCase();
    const taskType = ctx.taskType || await resolveTaskType(job, ctx.testCacheDir);
    const context = { ...ctx, taskType };

    if (gradingType === "IOI" || taskType === 'Communication') return runIOI(job, context);
    if (gradingType === "ICPC") return runICPC(job, context);
    return runClassic(job, context);
}

module.exports = { runGrading };
