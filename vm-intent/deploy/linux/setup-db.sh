#!/usr/bin/env bash
# Creates the vmintent database and user in the local PostgreSQL, and writes the
# settings file the start scripts read (deploy/linux/vm-intent.env).
#   ./deploy/linux/setup-db.sh            (asks sudo for the postgres user)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/vm-intent.env"

PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vmintent') THEN
    CREATE ROLE vmintent LOGIN PASSWORD '$PASSWORD';
  ELSE
    ALTER ROLE vmintent PASSWORD '$PASSWORD';
  END IF;
END\$\$;
SELECT 'CREATE DATABASE vmintent OWNER vmintent' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'vmintent')\gexec
SQL

# Many workflows at once need more connections than the default 100.
sudo -u postgres psql -c "ALTER SYSTEM SET max_connections = 400" >/dev/null
sudo systemctl restart postgresql

umask 077
cat > "$ENV_FILE" <<EOF
# Read by start-api.sh, start-worker.sh and the systemd units. Keep it private.
TEMPORAL_ADDRESS=127.0.0.1:7233
VMINTENT_DB_EMBEDDED=false
VMINTENT_DB_URL=jdbc:postgresql://127.0.0.1:5432/vmintent
VMINTENT_DB_USER=vmintent
VMINTENT_DB_PASSWORD=$PASSWORD
VMINTENT_DB_POOL=30
EOF
echo "Database ready. Settings written to $ENV_FILE"
echo "If login fails, allow password logins for 127.0.0.1 in pg_hba.conf (method scram-sha-256)."
