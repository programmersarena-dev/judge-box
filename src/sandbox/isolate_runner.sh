#!/bin/sh
# Production-grade isolate wrapper with cgroups v2 enforcement.
# Supports fine-grained resource control, process limits, and output truncation.
# Usage:
#  sh isolate_runner.sh compile <memory_mb> <time_s> "<compile_command>" <tmpDir>
#  sh isolate_runner.sh run <memory_mb> <time_s> "<execute_command>" <tmpDir>

set -e

ACTION=$1
MEM=${2:-256}
TIMEOUT=${3:-1}
CMD=$4
TMPDIR=$5

if [ -z "$ACTION" ] || [ -z "$CMD" ] || [ -z "$TMPDIR" ]; then
  echo "usage: $0 (compile|run) <mem_mb> <timeout_s> \"<cmd>\" <tmpdir>"
  exit 2
fi

# Find or allocate isolate box
BOX_ID=$(isolate --init 2>&1 | grep -oP '\d+' | head -1)
if [ -z "$BOX_ID" ]; then
  BOX_ID=0
fi

BOX_DIR="/var/lib/isolate/box/${BOX_ID}/box"
mkdir -p "$BOX_DIR"

# Clean and copy submission files (limit to 100MB total)
find "$BOX_DIR" -type f -exec rm {} \; 2>/dev/null || true
du -s "$TMPDIR" | awk '{if ($1 > 102400) exit 1}'
if [ $? -eq 1 ]; then
  echo "Submission exceeds 100MB size limit"
  exit 1
fi

cp -r "$TMPDIR"/* "$BOX_DIR/" 2>/dev/null || true

# Enforce cgroups limits via isolate
# Note: isolate v1.9+ supports --box-cgroup for cgroup enforcement
ISOLATE_OPTS="--box-id=$BOX_ID --cg --cg-mem=${MEM}M --timeout=$TIMEOUT --wall-time=$((TIMEOUT + 1)) --max-processes=1 --stack=8192 --extra-time=1"

cleanup_box() {
  isolate $ISOLATE_OPTS --cleanup >/dev/null 2>&1 || true
}

trap cleanup_box EXIT

if [ "$ACTION" = "compile" ]; then
  output=$(isolate $ISOLATE_OPTS --run -- /bin/sh -c "$CMD" 2>&1 | head -c 500000) || EXIT=$?
  echo "$output"
  exit ${EXIT:-0}
elif [ "$ACTION" = "run" ]; then
  output=$(isolate $ISOLATE_OPTS --run -- /bin/sh -c "/usr/bin/time -f '\nTime: %e\nMemory: %M' timeout ${TIMEOUT}s $CMD < box/input.txt 2>&1" 2>&1 | head -c 1000000) || EXIT=$?
  echo "$output"
  exit ${EXIT:-0}
else
  echo "unknown action"
  exit 2
fi
