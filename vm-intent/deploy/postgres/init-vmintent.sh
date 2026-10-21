#!/bin/sh
# Runs once, when the Postgres volume is first created: makes the app's own database and user.
# (Temporal's databases are created by the temporal container.)
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<EOSQL
CREATE ROLE vmintent LOGIN PASSWORD '${VMINTENT_DB_PASSWORD}';
CREATE DATABASE vmintent OWNER vmintent;
EOSQL
