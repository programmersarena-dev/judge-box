# ProgrammersArena Judge-Box Guide

This guide consolidates the judge-box integration, deployment, and operational documentation into a single README file.

## Overview

The system uses a separated **judge-box** architecture for secure code execution.

Architecture:

Frontend (React)
    ↓
Backend (Laravel) → Redis Queue → Judge-Box (Node.js)
    ↑                                    ↓
    ←──── Judge Results Queue ←─────────

Components:
- **Backend (Laravel)**: API server; creates `Submission` records and pushes jobs to Redis `judge:jobs` queue
- **Judge-Box (Node.js daemon)**: Pulls jobs from Redis, executes code in sandboxed environments (Docker/isolate), pushes results to Redis `judge:results` queue
- **Judge Consumer**: Laravel command that pulls results from `judge:results` queue and updates submissions in the database

## Files Created

### Judge-Box Directory Structure

```
judge-box/
├── config/
│   ├── languages.json          # Language configs (compile/execute commands)
│   └── judge-box.json          # System config (isolate, cgroups, Redis)
├── src/
│   ├── daemon/
│   │   ├── index.js            # Node.js HTTP/Redis worker
│   │   └── package.json        # Dependencies (express, ioredis)
│   ├── sandbox/
│   │   └── isolate_runner.sh   # Production isolate wrapper
│   └── checkers/
│       └── check.sh            # Output comparison script
├── Dockerfile                   # Multi-compiler image with isolate
├── docker-compose.yml          # Local dev setup with Redis
└── README.md                    # Quick start & architecture docs
```

### Backend Integration Files

```
backend/
├── app/
│   ├── Jobs/
│   │   └── GradeSubmissionJob.php        # Pushes to Redis judge:jobs
│   ├── Console/Commands/
│   │   └── JudgeQueueWorker.php          # Pulls from Redis judge:results
│   ├── Http/Controllers/
│   │   └── SubmissionController.php      # Updated to use new queue
│   └── Models/
│       └── Submission.php                # Added status, time, memory fields
├── config/
│   └── judge.php                         # Updated config with Redis settings
├── database/migrations/
│   └── 2024_06_21_000000_add_judge_queue_columns_to_submissions.php
├── docker-compose.yml                    # Added Redis & judge-consumer services
└── .env.example                          # Added JUDGE_MODE & JUDGE_REDIS_URL
```

## Key Changes to Backend

### SubmissionController
Updated to dispatch `GradeSubmissionJob` instead of direct judge host execution.

### New Queue Jobs
- **GradeSubmissionJob**: Pushes job payload to `judge:jobs` queue
- **JudgeQueueWorker**: Listens to `judge:results` queue and updates submission records

### Database Schema
New columns on `submissions`:
- `status`
- `output`
- `time`
- `memory`
- `error_message`
- `judged_at`

## Execution Modes

### Development (Docker-based)

```bash
EXEC_MODE=docker node src/daemon/index.js
```

- Runs submissions in Docker containers
- Simple and portable
- Higher overhead than isolate

### Production (isolate-based)

```bash
EXEC_MODE=isolate node src/daemon/index.js
```

- Uses lightweight isolate sandbox
- Better security and performance
- Requires isolate installed on host

## Queue Protocol

### Job Format (to `judge:jobs`)

```json
{
  "id": "sub-{submission_id}-{uniqid}",
  "language": "gcc",
  "version": "10",
  "files": {
    "submission.cpp": "..."
  },
  "input": "1 2\n",
  "expected_output": "3\n",
  "time_limit": 1,
  "memory_limit": 256
}
```

### Result Format (from `judge:results`)

```json
{
  "id": "sub-{submission_id}-{uniqid}",
  "result": {
    "status": "AC|WA|CE|TLE|MLE|RE",
    "time_used_ms": 142,
    "memory_used_kb": 4096,
    "raw_output": "3",
    "error_message": null
  }
}
```

## Prerequisites

- Docker & Docker Compose
- Redis (shared between backend and judge-box)
- PostgreSQL for backend
- For isolate mode: Linux kernel with cgroups v2 and isolate CLI installed

## Environment Variables

### Backend `.env`

```env
JUDGE_MODE=queue
JUDGE_REDIS_URL=redis://redis:6379/0
REDIS_HOST=redis
REDIS_PORT=6379
```

### Judge-Box `.env`

```env
EXEC_MODE=docker
ENABLE_REDIS=1
REDIS_URL=redis://redis:6379
```

## Quick Start: Docker Compose (Development)

### Option 1: Full Stack (Backend + Judge-Box)

From the project root:

```bash
cd backend
docker-compose up --build
```

In another terminal:

```bash
cd judge-box
docker-compose up --build
```

Verify:
- Backend API: http://localhost:8000
- Frontend: http://localhost:3000
- Judge daemon HTTP: http://localhost:3001
- Redis: localhost:6379

### Option 2: Run Services Manually (No Docker)

Terminal 1: Redis
```bash
redis-server --port 6379
```

Terminal 2: Backend
```bash
cd backend
php artisan serve --port 8000
php artisan queue:work redis
php artisan judge:worker
```

Terminal 3: Judge-Box
```bash
cd judge-box/src/daemon
npm install
EXEC_MODE=docker ENABLE_REDIS=1 REDIS_URL=redis://127.0.0.1:6379 node index.js
```

## Testing the System

### Test 1: Direct HTTP Job (Judge-Box)

```bash
curl -X POST http://localhost:3001/job \
  -H 'Content-Type: application/json' \
  -d '{
    "language": "gcc",
    "version": "10",
    "files": {
      "submission.cpp": "#include<bits/stdc++.h>\nusing namespace std;\nint main(){int a,b; cin>>a>>b; cout<<a+b; return 0;}"
    },
    "input": "1 2",
    "expected_output": "3",
    "time_limit": 1,
    "memory_limit": 256
  }'
```

Expected response:

```json
{
  "status": "OK",
  "time_used_ms": 5,
  "memory_used_kb": 1024,
  "raw_output": "3",
  "error_message": null
}
```

### Test 2: Via Backend API (Full Flow)

1. Create a contest and problem via the backend API
2. Submit code as a user
3. Watch submission status change: Queued → Judging → Accepted/Wrong Answer
4. Results appear in real-time

```bash
curl -X POST http://localhost:8000/api/contests/{id}/problems/A/submit \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "#include<bits/stdc++.h>\nusing namespace std;\nint main(){cout<<\"Hello World\";}",
    "language": "gcc-10"
  }'
```

## Production Deployment

### Using isolate (Recommended)

1. Host setup:

```bash
apt-get update && apt-get install isolate
echo "cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime 0 0" >> /etc/fstab
mount -a
isolate --init
```

2. Run judge-box with isolate:

```bash
EXEC_MODE=isolate ENABLE_REDIS=1 node src/daemon/index.js
```

### Docker Stack (Production-Ready)

Update `judge-box/docker-compose.yml`:

```yaml
judge-daemon:
  environment:
    EXEC_MODE: isolate
    ENABLE_REDIS: "1"
  volumes:
    - /var/lib/isolate:/var/lib/isolate
```

### Separate Judge-Box Host

```bash
docker run -d \
  -e REDIS_URL=redis://backend-redis:6379 \
  -e EXEC_MODE=isolate \
  -e ENABLE_REDIS=1 \
  -p 3001:3001 \
  judge-box:latest
```

Ensure backend and judge-box can communicate via Redis on a private network.

## Monitoring & Debugging

### Redis Queue Monitoring

```bash
redis-cli LLEN judge:jobs
redis-cli LLEN judge:results
redis-cli LRANGE judge:jobs 0 -1
redis-cli LRANGE judge:results 0 -1
redis-cli DEL judge:jobs judge:results
```

### Judge-Box Logs

```bash
docker logs judge-daemon
# or
node src/daemon/index.js
```

### Backend Logs

```bash
cd backend
tail -f storage/logs/laravel.log
```

## Troubleshooting

### Issue: Judge-Box Can't Connect to Redis
- Check `REDIS_URL`
- Verify Redis is running
- Run `redis-cli PING` from judge-box container

### Issue: Submissions Stuck in "Queued"
- Ensure judge-daemon is running
- Ensure `php artisan judge:worker` is running

### Issue: TLE or MLE Not Detected
- Ensure `timeout` is installed in Docker image
- Use isolate mode for better enforcement

### Issue: Output Checker Failing
- Check expected output line endings
- Verify checker logic in `judge-box/src/checkers/check.sh`

## Performance Tuning

- Run multiple judge-daemon instances
- Increase memory for concurrent containers
- Use isolate instead of Docker
- Cache compiled artifacts per language/version
- Use `-O2` optimization for C++

## Supported Languages

| Language   | Versions           | Extension | Compilation |
|------------|--------------------|-----------|-------------|
| C++        | 10, 11, 12         | cpp       | Yes         |
| Python     | 3.8, 3.9, 3.10     | py        | No          |
| PHP        | 7.4, 8.0, 8.1      | php       | No          |
| Java       | 8, 11, 17          | java      | Yes         |
| JavaScript | 12, 14, 16         | js        | No          |
| Rust       | 1.70, 1.75, stable | rs        | Yes         |

## Security Hardening Checklist

- [ ] Run judge-box on a separate host/VM
- [ ] Encrypt network traffic between backend and judge-box
- [ ] Use Redis authentication
- [ ] Use isolate instead of Docker in production
- [ ] Enable cgroups v2 on judge host
- [ ] Enforce file upload limits
- [ ] Enable output truncation
- [ ] Disable unsafe compilation options for C++

## References

- Isolate documentation: https://github.com/ioi/isolate
- Redis queues: https://redis.io/docs/interact/stream-info/
- cgroups v2: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
