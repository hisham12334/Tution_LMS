#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 /path/to/backup.dump.age /path/to/age-identity.txt" >&2
  exit 2
fi
ARCHIVE="$1"
IDENTITY="$2"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d /var/tmp/tution-lms-restore-test.XXXXXX)"
DB_NAME="tution_lms_restore_test"
trap 'rm -rf -- "${WORK_DIR}"' EXIT
age --decrypt --identity "${IDENTITY}" --output "${WORK_DIR}/restore.dump" "${ARCHIVE}"
docker compose -f "${ROOT_DIR}/docker-compose.yml" exec -T db sh -ec 'createdb -U "$POSTGRES_USER" tution_lms_restore_test'
docker compose -f "${ROOT_DIR}/docker-compose.yml" exec -T db sh -ec 'pg_restore -U "$POSTGRES_USER" -d tution_lms_restore_test --exit-on-error' < "${WORK_DIR}/restore.dump"
docker compose -f "${ROOT_DIR}/docker-compose.yml" exec -T db sh -ec 'psql -U "$POSTGRES_USER" -d tution_lms_restore_test -c "select count(*) as restored_tables from pg_tables"'
echo "Restore test completed into ${DB_NAME}; inspect counts and application queries before dropping this test database."
