const { randomUUID } = require('node:crypto');
const { runCommand } = require('./runCommand');
const { SANDBOX_FLAGS } = require('../config');
const { sandboxUser } = require('./workspace');

async function runDocker(image, directory, memory, command, options = {}) {
    const name = `arena-${randomUUID()}`;
    const { extraArgs = [], ...processOptions } = options;
    const result = await runCommand('docker', [
        'run', '--rm', '--name', name, '--network', 'none', `--memory=${memory}m`,
        ...SANDBOX_FLAGS.trim().split(/\s+/).filter(Boolean),
        '--user', sandboxUser().join(':'),
        '-e', 'GOCACHE=/submission/.go-cache',
        '-v', `${directory}:/submission`, '-w', '/submission', ...extraArgs,
        image, ...command,
    ], processOptions);
    if (result.timedOut || result.outputLimited) {
        // A terminated Docker CLI may leave its container running.
        await runCommand('docker', ['rm', '-f', name], { timeout: 10000 });
    }
    return result;
}

module.exports = { runDocker };
