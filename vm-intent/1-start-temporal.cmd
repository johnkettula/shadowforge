@echo off
REM Starts a local Temporal server. Web UI: http://localhost:8233
REM Data is kept in temporal-dev.db so workflows survive a restart.
temporal server start-dev --db-filename temporal-dev.db
