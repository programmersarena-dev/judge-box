const { runClassic } = require("./classic");

// ICPC: judging-wise identical to Classic today — single binary
// Accepted/Rejected verdict, stop at first failure. ICPC's real
// distinguishing feature (a time penalty added to standings per wrong
// submission before an eventual Accepted) is a *contest standings*
// concern computed from submission history, not a per-submission
// judging concern. Kept as its own module so that distinction stays
// visible and per-test ICPC behavior can diverge later without
// touching Classic.
async function runICPC(job, ctx) {
    return runClassic(job, ctx);
}

module.exports = { runICPC };