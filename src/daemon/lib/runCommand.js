const { exec } = require("child_process");

function runCommand(cmd, opts = {}) {
    return new Promise((resolve) => {
        const child = exec(cmd, { ...opts, timeout: 30000 }, (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr || '');
            const code = err && typeof err.code === 'number' ? err.code : (err && err.killed ? 124 : 0);
            resolve({ out: out.trim(), code });
        });
    });
}

module.exports = { runCommand };