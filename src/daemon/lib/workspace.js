const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { SANDBOX_FLAGS } = require('../config');

function sandboxUser() {
    const match = SANDBOX_FLAGS.match(/(?:^|\s)--user(?:=|\s+)(\d+):(\d+)(?:\s|$)/);
    return match ? [Number(match[1]), Number(match[2])]
        : [process.getuid?.() || 1000, process.getgid?.() || 1000];
}

function safeFilePath(root, name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name)) {
        throw new Error('Invalid job filename');
    }
    return path.join(root, name);
}

async function createWorkspace() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-submission-'));
    try {
        const [uid, gid] = sandboxUser();
        if (process.getuid?.() === 0) {
            await fs.chown(directory, uid, gid);
        }
        await fs.chmod(directory, 0o700);
        return directory;
    } catch (error) {
        await fs.remove(directory);
        throw error;
    }
}

module.exports = { safeFilePath, createWorkspace, sandboxUser };
