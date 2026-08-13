const { runClassic } = require("./classic");
const { runICPC } = require("./icpc");
const { runIOI } = require("./ioi");

async function runGrading(job, ctx) {
    const gradingType = (job.grading_type || "Standard").toUpperCase();

    if (gradingType === "IOI") return runIOI(job, ctx);
    if (gradingType === "ICPC") return runICPC(job, ctx);
    return runClassic(job, ctx);
}

module.exports = { runGrading };