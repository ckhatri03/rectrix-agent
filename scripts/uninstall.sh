#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-rectrix-agent.service}"
SERVICE_USER="${SERVICE_USER:-rectrix-agent}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/rectrix-agent}"
APP_DIR="${APP_DIR:-${INSTALL_ROOT}/app}"
STATE_DIR="${STATE_DIR:-/var/lib/rectrix-agent}"
ENV_DIR="${ENV_DIR:-/etc/rectrix-agent}"
SYSTEMD_UNIT_DEST="${SYSTEMD_UNIT_DEST:-/etc/systemd/system/rectrix-agent.service}"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/rectrix-agent}"
PURGE_DATA=0

usage() {
  cat <<'EOF'
Usage: sudo bash uninstall.sh [--purge] [--help]

Options:
  --purge   Also remove /etc/rectrix-agent and /var/lib/rectrix-agent.
  --help    Show this help text.

Default behavior removes the Rectrix agent service, app files, and sudoers
entry, while preserving the env and state directories for later review or
reinstallation.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)
      PURGE_DATA=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "uninstall.sh must run as root" >&2
  exit 1
fi

systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
systemctl reset-failed "${SERVICE_NAME}" 2>/dev/null || true
rm -f "${SYSTEMD_UNIT_DEST}"
rm -f "${SUDOERS_FILE}"
systemctl daemon-reload

rm -rf "${APP_DIR}"
rmdir "${INSTALL_ROOT}" 2>/dev/null || true

if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  userdel "${SERVICE_USER}" 2>/dev/null || true
fi

if [[ "${PURGE_DATA}" -eq 1 ]]; then
  rm -rf "${ENV_DIR}" "${STATE_DIR}"
fi

echo "Rectrix agent uninstall complete."
echo "Removed:"
echo "  ${SYSTEMD_UNIT_DEST}"
echo "  ${SUDOERS_FILE}"
echo "  ${APP_DIR}"
echo "  service user: ${SERVICE_USER} (if present)"

if [[ "${PURGE_DATA}" -eq 1 ]]; then
  echo "Removed additional data:"
  echo "  ${ENV_DIR}"
  echo "  ${STATE_DIR}"
else
  echo "Preserved:"
  echo "  ${ENV_DIR}"
  echo "  ${STATE_DIR}"
  echo
  echo "Run again with --purge if you also want to remove saved credentials and local state."
fi

echo
echo "Not removed:"
echo "  Node.js runtime"
echo "  Mosquitto or Telegraf packages"
echo "  agent-managed broker or telegraf workload files outside the Rectrix agent directories"
