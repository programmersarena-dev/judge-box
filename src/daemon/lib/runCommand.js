const { execFile } = require('node:child_process');

function runCommand(file, args = [], opts = {}) {
    if (!Array.isArray(args)) throw new TypeError('Command arguments must be an array');
    return new Promise((resolve) => {
        execFile(file, args, { timeout: 30000, ...opts, shell: false }, (err, stdout, stderr) => {
            const outputLimited = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            const timedOut = Boolean(err?.killed) && !outputLimited;
            const code = !err ? 0 : outputLimited ? 125 : timedOut ? 124
                : typeof err.code === 'number' ? err.code : 1;
            resolve({ out: ((stdout || '') + (stderr || '')).trim(), code, timedOut, outputLimited });
        });
    });
}

module.exports = { runCommand };
