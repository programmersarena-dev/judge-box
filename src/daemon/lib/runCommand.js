const { exec } = require("child_process");

function runCommand(cmd, opts = {}) {
    return new Promise((resolve) => {
        exec(cmd, opts, (err, stdout, stderr) => {
            const out = (stdout || "") + (stderr || "");
            const code = err && typeof err.code === "number" ? err.code : 0;
            resolve({ out: out.trim(), code });
        });
    });
}

module.exports = { runCommand };