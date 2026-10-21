#!/usr/bin/env bash
# Installs what vm-intent needs on Ubuntu/Debian (apt) or RHEL/Rocky/Fedora (dnf):
# Java 21, Maven, Node.js, PostgreSQL and the Temporal CLI. Run with sudo.
#   sudo ./deploy/linux/install-prereqs.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

if command -v apt-get >/dev/null; then
  apt-get update
  apt-get install -y openjdk-21-jdk-headless maven nodejs npm postgresql curl
elif command -v dnf >/dev/null; then
  dnf install -y java-21-openjdk-devel maven nodejs npm postgresql-server postgresql curl
  if [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then postgresql-setup --initdb; fi
else
  echo "Unsupported Linux: install Java 21, Maven, Node.js 20+, PostgreSQL 14+ and the Temporal CLI yourself." >&2
  exit 1
fi
systemctl enable --now postgresql

# Temporal CLI (includes a single-binary dev server). Installs to /usr/local/bin.
if ! command -v temporal >/dev/null; then
  curl -sSf https://temporal.download/cli.sh | sh
  install -m 755 "$HOME/.temporalio/bin/temporal" /usr/local/bin/temporal
fi

echo
java -version 2>&1 | head -1
mvn -v | head -1
echo "node $(node -v)"
psql --version
temporal --version
echo "Done. Next: ./deploy/linux/setup-db.sh"
