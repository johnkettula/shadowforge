#!/bin/sh
# Checks and publishes catalog definitions (YAML) to vm-intent. Made for a Git pipeline: the
# definitions live in a repository, a merge request is reviewed and approved there, and on merge
# the pipeline runs this. It stops at the first file with problems and prints all of them.
#
#   VMINTENT_URL=https://vm-intent.example.com  VMINTENT_TOKEN=<Entra ID token for an OPERATOR>  \
#     deploy/catalog/publish.sh definitions/*.yaml
#
#   --check   only check (for the merge request pipeline): nothing is published
#
# Publishing the same version with the same content again does nothing, so the pipeline can send
# every file on every merge. A changed file must have a higher version.
set -eu
CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi
: "${VMINTENT_URL:?set VMINTENT_URL, e.g. http://localhost:8080}"
[ $# -gt 0 ] || { echo "usage: $0 [--check] file.yaml..." >&2; exit 2; }
AUTH=""
[ -n "${VMINTENT_TOKEN:-}" ] && AUTH="Authorization: Bearer $VMINTENT_TOKEN"

# Blueprints first: definitions may name them.
FILES=$(for f in "$@"; do if grep -q '^kind: *Blueprint' "$f"; then echo "0 $f"; else echo "1 $f"; fi; done | sort | cut -d' ' -f2-)
failed=0
for f in $FILES; do
  if [ "$CHECK" = 1 ]; then
    out=$(curl -sS -X POST -H "Content-Type: application/yaml" ${AUTH:+-H "$AUTH"} --data-binary "@$f" "$VMINTENT_URL/api/v2/definitions/validate")
    case "$out" in
      *'"ok":true'*) echo "ok        $f" ;;
      *) echo "PROBLEMS  $f: $out"; failed=1 ;;
    esac
  else
    code=$(curl -sS -o /tmp/publish.$$ -w '%{http_code}' -X POST -H "Content-Type: application/yaml" ${AUTH:+-H "$AUTH"} \
      --data-binary "@$f" "$VMINTENT_URL/api/v2/definitions")
    case "$code" in
      201) echo "published $f" ;;
      200) echo "unchanged $f" ;;
      *) echo "REFUSED   $f (HTTP $code): $(cat /tmp/publish.$$)"; failed=1 ;;
    esac
    rm -f /tmp/publish.$$
  fi
  [ "$failed" = 0 ] || exit 1
done
