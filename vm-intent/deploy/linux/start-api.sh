#!/usr/bin/env bash
# Starts the REST API (no workers) on port 8080.
#   ./deploy/linux/start-api.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
set -a; . "$HERE/vm-intent.env"; set +a
export SPRING_PROFILES_ACTIVE=api
exec java -XX:MaxRAMPercentage=25 -jar "$ROOT/backend/target/vm-intent-0.1.0.jar"
