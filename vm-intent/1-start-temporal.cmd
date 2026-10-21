@echo off
REM Starts a local Temporal server. Web UI: http://localhost:8233
REM Data is kept in temporal-dev.db so workflows survive a restart.
REM --ui-ip 0.0.0.0 opens the Web UI to other devices on your network (http://<this PC's IP>:8233).
REM The server itself (port 7233) stays reachable from this PC only.
temporal server start-dev --db-filename temporal-dev.db --ui-ip 0.0.0.0
