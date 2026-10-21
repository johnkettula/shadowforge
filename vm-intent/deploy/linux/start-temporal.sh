#!/usr/bin/env bash
# Starts Temporal's single-binary server, keeping its data in ~/.vm-intent/temporal.db.
# Good for a sandbox. For production use docker-compose.yml (Postgres-backed) or Temporal's Helm chart.
#   ./deploy/linux/start-temporal.sh        UI at http://<host>:8233
set -euo pipefail
mkdir -p "$HOME/.vm-intent"
exec temporal server start-dev \
  --ip 0.0.0.0 \
  --ui-port 8233 \
  --db-filename "$HOME/.vm-intent/temporal.db" \
  --dynamic-config-value 'frontend.namespaceRPS=4800' \
  --dynamic-config-value 'frontend.rps=4800'
