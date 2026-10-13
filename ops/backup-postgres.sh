#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
BACKUP_CONFIG="${BACKUP_CONFIG:-/etc/tution-lms-backup.conf}"
LOCK_FILE="/run/tution-lms-backup/backup.lock"
WORK_DIR="$(mktemp -d /var/tmp/tution-lms-backup.XXXXXX)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAILY_NAME="tution-lms-${STAMP}.dump.age"
[[ -r "${BACKUP_CONFIG}" ]] || { echo "Missing root-owned backup config ${BACKUP_CONFIG}" >&2; exit 1; }
# shellcheck disable=SC1090
source "${BACKUP_CONFIG}"
REMOTE="${BACKUP_RCLONE_REMOTE:?Set BACKUP_RCLONE_REMOTE in ${BACKUP_CONFIG}}"
RECIPIENT="${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT in ${BACKUP_CONFIG}}"
DAILY_REMOTE="${REMOTE%/}/daily/${DAILY_NAME}"
WEEKLY_REMOTE="${REMOTE%/}/weekly/${DAILY_NAME}"

cleanup() { rm -rf -- "${WORK_DIR}"; }
failed() {
  status=$?
  logger -p user.err -t tution-lms-backup "Backup failed (exit ${status}); review the VPS backup service log."
  if [[ -n "${BACKUP_ALERT_COMMAND:-}" ]]; then
    bash -c "${BACKUP_ALERT_COMMAND}" >/dev/null 2>&1 || true
  fi
  exit "${status}"
}
trap cleanup EXIT
trap failed ERR

[[ -r "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
command -v docker >/dev/null
command -v age >/dev/null
command -v rclone >/dev/null
exec 9>"${LOCK_FILE}"
flock -n 9 || { echo "Another backup is already running." >&2; exit 1; }

cd "${ROOT_DIR}"
docker compose --env-file "${ENV_FILE}" exec -T db sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "${WORK_DIR}/${DAILY_NAME%.age}"
docker compose --env-file "${ENV_FILE}" exec -T db pg_restore --list - < "${WORK_DIR}/${DAILY_NAME%.age}" > "${WORK_DIR}/archive.list"
[[ -s "${WORK_DIR}/archive.list" ]]
age --encrypt --recipient "${RECIPIENT}" --output "${WORK_DIR}/${DAILY_NAME}" "${WORK_DIR}/${DAILY_NAME%.age}"
[[ -s "${WORK_DIR}/${DAILY_NAME}" ]]

rclone copyto "${WORK_DIR}/${DAILY_NAME}" "${DAILY_REMOTE}"
rclone check --download "${WORK_DIR}" "${REMOTE%/}/daily" --include "${DAILY_NAME}"

# Store a weekly recovery point on Sundays. Retention runs only after the new
# daily object has been uploaded and read back successfully.
if [[ "$(date -u +%u)" == "7" ]]; then
  rclone copyto "${WORK_DIR}/${DAILY_NAME}" "${WEEKLY_REMOTE}"
  rclone check --download "${WORK_DIR}" "${REMOTE%/}/weekly" --include "${DAILY_NAME}"
fi
rclone delete "${REMOTE%/}/daily" --min-age 7d --include '*.age'
rclone delete "${REMOTE%/}/weekly" --min-age 28d --include '*.age'
logger -p user.notice -t tution-lms-backup "Encrypted PostgreSQL backup uploaded and verified: ${DAILY_NAME}"
