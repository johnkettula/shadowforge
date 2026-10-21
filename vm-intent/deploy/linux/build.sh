#!/usr/bin/env bash
# Builds the backend jar and the web app.
#   ./deploy/linux/build.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
(cd "$ROOT/backend" && mvn -q -B -DskipTests package)
(cd "$ROOT/frontend" && npm ci --no-audit --no-fund && npm run build)
echo "Built $ROOT/backend/target/vm-intent-0.1.0.jar and $ROOT/frontend/dist"
