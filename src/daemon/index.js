const express = require("express");
const bodyParser = require("body-parser");
const { processJob } = require("./processJob");
const { refreshLocalImageInventory } = require("./lib/dockerImages");
const { startRedisWorker } = require("./redisWorker");
const { PORT, ENABLE_REDIS } = require("./config");
const { fork } = require("child_process");
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

app.post("/job", async (req, res) => {
    const result = await processJob(req.body);
    return res.json(result);
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

function startReaper() {
    const reaperPath = path.join(__dirname, "judge-reaper.js");
    const child = fork(reaperPath, [], {
        stdio: "inherit",
        detached: false,
    });
    child.on("error", (err) => {
        console.error("[Reaper] failed to start:", err);
    });
    child.on("exit", (code, signal) => {
        console.warn(`[Reaper] exited with code ${code}, signal ${signal} – restarting in 2s...`);
        setTimeout(startReaper, 2000);
    });
    console.log("[Reaper] started as child process");
    return child;
}

async function main() {
    await refreshLocalImageInventory();

    app.listen(PORT, () => console.log(`Judge daemon listening on :${PORT}`));

    if (ENABLE_REDIS) {
        startRedisWorker();
+       startReaper();
    }
}

main();