#!/usr/bin/env bash
# Starts one worker process. Run it several times (or on several machines) to scale out.
#   ./deploy/linux/start-worker.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
set -a; . "$HERE/vm-intent.env"; set +a
export SPRING_PROFILES_ACTIVE=worker
exec java -Xmx2g -XX:+UseG1GC -jar "$ROOT/backend/target/vm-intent-0.1.0.jar"
