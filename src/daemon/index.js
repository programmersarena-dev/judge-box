const express = require("express");
const bodyParser = require("body-parser");
const { processJob } = require("./processJob");
const { refreshLocalImageInventory } = require("./lib/dockerImages");
const { startRedisWorker } = require("./redisWorker");
const { PORT, ENABLE_REDIS } = require("./config");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

app.post("/job", async (req, res) => {
    const result = await processJob(req.body);
    return res.json(result);
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

async function main() {
    // Build the local docker image inventory to completion BEFORE this
    // node starts pulling jobs off the queue at all — the requested
    // "check images first, then get data from Redis" order. Without this
    // await, the daemon could start consuming immediately and the very
    // first job would hit an empty in-memory inventory (still correct,
    // via the per-check live fallback in dockerImages.js, just slower and
    // less complete than having the full list ready up front).
    await refreshLocalImageInventory();

    app.listen(PORT, () => console.log(`Judge daemon listening on :${PORT}`));

    if (ENABLE_REDIS) {
        startRedisWorker();
    }
}

main();