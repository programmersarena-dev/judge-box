const { runClassic } = require("./classic");
const { runICPC } = require("./icpc");
const { runIOI } = require("./ioi");
const fs = require("fs-extra");
const path = require("path");

async function runGrading(job, ctx) {
    const gradingType = (job.grading_type || "Standard").toUpperCase();
    const isCommunication = (job.task_type || "Batch") === "Communication"
        || (ctx.testCacheDir && fs.existsSync(path.join(ctx.testCacheDir, "graders")));

    if (gradingType === "IOI" || isCommunication) return runIOI(job, ctx);
    if (gradingType === "ICPC") return runICPC(job, ctx);
    return runClassic(job, ctx);
}

module.exports = { runGrading };