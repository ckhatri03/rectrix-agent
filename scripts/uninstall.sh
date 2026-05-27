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

Default behavior removes the Rectrix agent service, app files, sudoers
entry, agent-managed MQTT/Telegraf workload files, and agent-created
Let's Encrypt / Mosquitto certificate artifacts.
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

WORKLOAD_UNIT_REGEX='^[0-9]+_[a-z0-9_]+_(mqtt|telegraf)\.service$'
WORKLOAD_UNITS=()
REMOVED_HOSTNAMES=()

append_if_exists() {
  local candidate="$1"
  if [[ -e "${candidate}" || -L "${candidate}" ]]; then
    WORKLOAD_UNITS+=("${candidate}")
  fi
}

remove_if_present() {
  local candidate="$1"
  if [[ -e "${candidate}" || -L "${candidate}" ]]; then
    rm -rf "${candidate}"
  fi
}

collect_workload_units() {
  local unit_path
  shopt -s nullglob
  for unit_path in /etc/systemd/system/*.service; do
    local unit_name
    unit_name="$(basename "${unit_path}")"
    if [[ "${unit_name}" =~ ${WORKLOAD_UNIT_REGEX} ]]; then
      WORKLOAD_UNITS+=("${unit_name}")
    fi
  done
  shopt -u nullglob
}

collect_cert_hostnames() {
  local credentials_dir="/etc/letsencrypt/rectrix-godaddy"
  local env_path
  if [[ ! -d "${credentials_dir}" ]]; then
    return 0
  fi
  shopt -s nullglob
  for env_path in "${credentials_dir}"/*.env; do
    REMOVED_HOSTNAMES+=("$(basename "${env_path}" .env)")
  done
  shopt -u nullglob
}

remove_workload_artifacts() {
  local unit_name service_name kind
  for unit_name in "${WORKLOAD_UNITS[@]}"; do
    service_name="${unit_name%.service}"
    kind="${service_name##*_}"

    systemctl disable --now "${unit_name}" 2>/dev/null || true
    systemctl reset-failed "${unit_name}" 2>/dev/null || true
    remove_if_present "/etc/systemd/system/${unit_name}"

    if [[ "${kind}" == "mqtt" ]]; then
      remove_if_present "/etc/mosquitto/${service_name}.conf"
      remove_if_present "/etc/mosquitto/passwords/${service_name}.passwd"
      remove_if_present "/etc/mosquitto/acl/${service_name}.acl"
      remove_if_present "/var/lib/mosquitto/${service_name}"
    elif [[ "${kind}" == "telegraf" ]]; then
      remove_if_present "/etc/telegraf/${service_name}.conf"
      remove_if_present "/var/lib/telegraf/${service_name}"
    fi
  done
}

remove_certificate_artifacts() {
  local hostname
  for hostname in "${REMOVED_HOSTNAMES[@]}"; do
    remove_if_present "/etc/letsencrypt/live/${hostname}"
    remove_if_present "/etc/letsencrypt/archive/${hostname}"
    remove_if_present "/etc/letsencrypt/renewal/${hostname}.conf"
    remove_if_present "/etc/mosquitto/certs/${hostname}"
  done

  remove_if_present "/etc/letsencrypt/rectrix-godaddy"

  if [[ -d "/etc/mosquitto/certs" ]]; then
    local maybe_default
    for maybe_default in "/etc/mosquitto/certs/fullchain.pem" "/etc/mosquitto/certs/privkey.pem"; do
      if [[ -L "${maybe_default}" ]]; then
        remove_if_present "${maybe_default}"
      fi
    done
  fi
}

collect_workload_units
collect_cert_hostnames

systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
systemctl reset-failed "${SERVICE_NAME}" 2>/dev/null || true
remove_workload_artifacts
remove_certificate_artifacts

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

echo "  agent-managed systemd workload units: ${#WORKLOAD_UNITS[@]}"
echo "  agent-managed certificate hostnames: ${#REMOVED_HOSTNAMES[@]}"

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
echo "  shared CA bundle files such as /etc/mosquitto/certs/ca.crt"
