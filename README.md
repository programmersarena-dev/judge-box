# Judge Daemon

A high‑performance, container‑native online judge executor with support for **Classic**, **ICPC**, and **IOI** grading styles. Built for scale with Redis queues, Docker sandboxing, and automatic stale job recovery.

---

## Features

- **Multiple grading modes** – Standard (all‑or‑nothing), ICPC (penalties handled externally), and IOI (partial subtask scoring).
- **Sandboxed execution** – Each submission runs inside a Docker container (or `isolate`) with strict CPU / memory limits.
- **Redis‑backed job queue** – Distribute judging work across multiple daemon instances.
- **Automatic reaper** – Recovers jobs that were picked up but never finished (e.g., worker crash).
- **Custom checkers** – C++ checker support for problems with multiple valid outputs.
- **Test case caching** – Download and extract problem test bundles once per (problem, version) pair.
- **Real‑time progress updates** – Pushes test‑by‑test status to Redis for live UI feedback.
- **Docker‑in‑Docker ready** – Designed to run inside a container with the host Docker socket mounted.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     judge-daemon container                  │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │   index.js  │───▶│ redisWorker  │───▶│  processJob  │    │
│  │  (HTTP API) │    │ (BRPOPLPUSH) │    │              │    │
│  └─────────────┘    └──────────────┘    └──────┬───────┘    │
│          ▲                                     │            │
│          │                                     ▼            │
│          │                            ┌─────────────────┐   │
│          │                            │   grading/      │   │
│          │                            │  sandbox logic  │   │
│          │                            └─────────────────┘   │
│          │                                     │            │
│          └───────────────┬─────────────────────┘            │
│                          │                                  │
│                    ┌─────▼─────┐                            │
│                    │ reaper.js │ (forked child)             │
│                    └───────────┘                            │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
    ┌────────┐        ┌────────────┐      ┌──────────────┐
    │ Redis  │        │  Docker    │      │ Laravel API  │
    │ queue  │        │  socket    │      │ (test fetch) │
    └────────┘        └────────────┘      └──────────────┘
```

---

## Getting Started

### Prerequisites

- Docker & Docker Compose
- A Redis instance (or use the included one in the compose file)
- Laravel backend (optional – provides test cases via an internal API)

### Quick Start with Docker Compose

1. Clone the repository.
2. Ensure your `config/judge-box.json` and `config/languages.json` are present (see [Configuration](#configuration)).
3. Run:

```bash
docker-compose up -d judge-daemon
```

The daemon will start on `http://localhost:3001`.

### Manual Start (without Docker)

```bash
cd /path/to/judge-box/src/daemon
npm install
node index.js
```

Environment variables like `REDIS_URL` and `ENABLE_REDIS` can be used to override settings (see below).

---

## Configuration

### `config/judge-box.json`

Main configuration file (loaded first). Keys:

| Key | Description |
|-----|-------------|
| `executionMode` | `"docker"` (default) or `"isolate"` |
| `port` | HTTP port (default `3001`) |
| `enableRedis` | `true` / `false` – enable Redis queue (default `true`) |
| `logLevel` | Log level (default `"info"`) |
| `redis` | Redis connection settings (host, port, prefix, etc.) |
| `testCache.dir` | Directory to cache test bundles (default `/var/cache/judge/tests`) |
| `laravel.internalUrl` | Base URL for fetching test cases (e.g., `http://laravel-backend:8001/api/v1`) |
| `laravel.secretToken` | Token for authenticating with the Laravel API |
| `docker.autoPullMissingImages` | Automatically pull missing language images (default `false`) |
| `ioi.testConcurrency` | Number of concurrent tests per IOI subtask (default `1`) |
| `reaper.staleMs` | Time after which a job is considered stuck (default `300000` – 5 min) |
| `reaper.scanIntervalMs` | How often the reaper scans (default `30000` – 30 sec) |
| `defaults.timeLimit` / `memoryLimit` | Fallback limits (seconds / MB) |

### `config/languages.json`

Defines supported languages:

```json
{
  "cpp": {
    "dockerImage": "gcc",
    "versions": ["12"],
    "execute": "./a.out",
    "commandCompile": "g++ -O2 -std=c++17 -o a.out solution.cpp"
  }
}
```

### Environment variables (override file settings)

| Variable | Effect |
|----------|--------|
| `EXEC_MODE` | Overrides `executionMode` |
| `ENABLE_REDIS` | `"1"` to enable, `"0"` to disable |
| `REDIS_URL` | Full Redis connection string (e.g. `redis://redis:6379`) |
| `JUDGE_STALE_MS` | Overrides `reaper.staleMs` |
| `JUDGE_SCAN_INTERVAL_MS` | Overrides `reaper.scanIntervalMs` |
| `AUTO_PULL_MISSING_IMAGES` | `"1"` to enable auto‑pull |

---

## Grading Modes

| Mode | Behavior |
|------|----------|
| **Classic** | Single verdict (AC/WA/TLE/...). Stops at first failed test. |
| **ICPC** | Judging identical to Classic; penalties are handled by the contest scoreboard. |
| **IOI** | Subtask‑based partial scoring. Every test in a subtask is executed (even after a failure); points awarded only if **all** tests in the subtask pass. |

The mode is selected per‑job by the `grading_type` field.

Grading mode (IOI scoring) is separate from task type (Batch or Communication).
Task type comes from `job.task_type`, then the bundle's `problem.json`. Legacy
bundles without metadata are Communication only when `graders/manager.cpp` is
present; a `graders/` directory alone does not imply Communication.

C++ Batch function tasks must provide `graders/grader.cpp` and any required
headers. The grader is copied into the private build directory and linked with
`submission.cpp` via `languages.gcc.commandCompileGrader`. The supplied GCC
configuration includes both translation units. Custom configurations must do
the same unless their grader already includes the contestant source. Other
language-specific Batch graders are not supported by this implementation.

---

## Sandbox Modes

### Docker (default)

Each submission runs in its own Docker container with:

- Network isolation (`--network none`)
- Memory limit (`--memory`)
- CPU / PID limits via `SANDBOX_FLAGS` (configurable)
- The Docker socket is mounted read‑only for the judge daemon to spawn containers.

### Isolate

Uses the `isolate` sandbox (not yet fully implemented; present for future expansion).

---

## Redis Queue & Worker

- **Queue**: `judge:jobs` (list)
- **Worker**: `brpoplpush` moves jobs from the main queue to a per‑worker `in‑progress` list, preventing double‑processing.
- **Progress**: During judging, real‑time updates are stored in Redis hashes and lists, and published to channels for WebSocket/SSE consumers.
- **Results**: After completion, the final result is pushed to `judge:results`.

---

## Reaper

A separate process (forked by `index.js`) that periodically scans all `judge:jobs:in‑progress:*` lists. If a job’s `processing_at` timestamp exceeds `STALE_MS`, the reaper:

1. Pushes the job back to the head of the main queue.
2. Removes it from the `in‑progress` list.
3. Deletes the processing timestamp.

This ensures no job is lost when a worker crashes.

---

## Health Checks

- `GET /health` – returns `{ status: "ok" }`
- **HTTP API** also exposes `POST /job` for direct (non‑Redis) submission for debugging.

---

## Custom Checkers

If a problem supplies a C++ checker, the daemon:

1. Compiles it once per job using the first configured `languages.gcc` image/version (`gcc:12` if absent). Install that image on every checker-capable worker.
2. For each test, runs the checker with arguments `input.txt output.txt expected.txt`.
3. Checker exit code `0` → OK; ordinary rejection → WA; timeouts, output limits, or Docker execution failures → Judge Error.

Checker output is captured and logged.

---

## Development

### File Structure

```
judge-box/
├── config/
│   ├── judge-box.json
│   └── languages.json
├── src/
│   ├── daemon/
│   │   ├── index.js            # Main entry point
│   │   ├── redisWorker.js      # Redis consumer
│   │   ├── processJob.js       # Job orchestration
│   │   ├── judge-reaper.js     # Stale job recovery
│   │   ├── grading/            # Grading logic (Classic, ICPC, IOI)
│   │   ├── lib/                # Helpers (sandbox, testCache, redis, dockerImages, checker, runCommand)
│   │   └── package.json
│   ├── checkers/               # (reserved for future built-in checkers)
│   └── sandbox/                # Isolate runner scripts (optional)
└── Dockerfile / docker-compose.yml
```

### Running Tests

Run the automated tests without connecting to the application's Redis instance:

```bash
cd src/daemon
npm ci
npm test
# Optional real-container tests; requires Docker access and the configured GCC image.
ARENA_DOCKER_TESTS=1 npm test
```

The Docker tests exercise concurrent input isolation, reference-answer separation,
and custom-checker exit codes. Isolate mode remains experimental and is not covered
by these integration tests. See the backend's `docs/optimization-rollout.md` for
the coordinated frontend/backend/judge rollout.

### Adding a New Language

1. Add an entry in `config/languages.json`.
2. Optionally, build a Docker image with the required compiler/runtime.
3. Ensure the image is present on all judge nodes (or enable `autoPullMissingImages`).

---

## License
