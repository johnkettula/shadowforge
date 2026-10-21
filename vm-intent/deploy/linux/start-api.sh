#!/usr/bin/env bash
# Starts the REST API (no workers) on port 8080, or HTTPS on 8443 with API_PROFILES=api,tls.
#   ./deploy/linux/start-api.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
set -a; . "$HERE/vm-intent.env"; set +a
export SPRING_PROFILES_ACTIVE="${API_PROFILES:-api}"
exec java -XX:MaxRAMPercentage=25 -jar "$ROOT/backend/target/vm-intent-0.1.0.jar"
