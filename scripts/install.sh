#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

REPO_OWNER="${REPO_OWNER:-ckhatri03}"
REPO_NAME="${REPO_NAME:-rectrix-agent}"
REPO_REF="${REPO_REF:-main}"
SERVICE_USER="${SERVICE_USER:-rectrix-agent}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/rectrix-agent}"
APP_DIR="${INSTALL_ROOT}/app"
STATE_DIR="${STATE_DIR:-/var/lib/rectrix-agent}"
ENV_DIR="${ENV_DIR:-/etc/rectrix-agent}"
ENV_FILE="${ENV_FILE:-${ENV_DIR}/agent.env}"
SYSTEMD_UNIT_DEST="${SYSTEMD_UNIT_DEST:-/etc/systemd/system/rectrix-agent.service}"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/rectrix-agent}"
ARCHIVE_URL="${ARCHIVE_URL:-https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/${REPO_REF}}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd tar
require_cmd node
require_cmd npm
require_cmd systemctl

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped_value

  escaped_value="$(printf '%s' "${value}" | sed -e 's/[&|\\]/\\&/g')"

  if grep -q "^${key}=" "${file}" 2>/dev/null; then
    sed -i "s|^${key}=.*$|${key}=${escaped_value}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${INSTALL_ROOT}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

mkdir -p "${INSTALL_ROOT}" "${STATE_DIR}" "${ENV_DIR}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_ROOT}" "${STATE_DIR}"

archive_file="${tmp_dir}/rectrix-agent.tar.gz"
curl -fsSL "${ARCHIVE_URL}" -o "${archive_file}"
tar -xzf "${archive_file}" -C "${tmp_dir}"

src_dir="$(find "${tmp_dir}" -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -n 1)"
if [[ -z "${src_dir}" ]]; then
  echo "Failed to unpack repository archive" >&2
  exit 1
fi

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}"
cp -R "${src_dir}/." "${APP_DIR}/"

pushd "${APP_DIR}" >/dev/null
npm ci
npm run build
popd >/dev/null

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}" "${STATE_DIR}"

install -D -m 0644 "${APP_DIR}/systemd/rectrix-agent.service" "${SYSTEMD_UNIT_DEST}"

if [[ ! -f "${ENV_FILE}" ]]; then
  install -D -m 0660 "${APP_DIR}/config/agent.example.env" "${ENV_FILE}"
  chown root:"${SERVICE_USER}" "${ENV_FILE}"
  echo "Created ${ENV_FILE}; update it before first start."
else
  chown root:"${SERVICE_USER}" "${ENV_FILE}" || true
  chmod 0660 "${ENV_FILE}" || true
fi

cat > "${SUDOERS_FILE}" <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/apt-get, /usr/bin/install, /usr/bin/rm, /usr/bin/journalctl
EOF
chmod 0440 "${SUDOERS_FILE}"

systemctl daemon-reload
systemctl enable rectrix-agent.service

manager_url="$(awk -F= '/^MANAGER_API_URL=/{print $2}' "${ENV_FILE}" | tail -n 1)"
activation_code="$(awk -F= '/^AGENT_ACTIVATION_CODE=/{print $2}' "${ENV_FILE}" | tail -n 1 | tr -d '\"' | tr '[:lower:]' '[:upper:]')"
agent_id="$(awk -F= '/^AGENT_ID=/{print $2}' "${ENV_FILE}" | tail -n 1)"
bootstrap_token="$(awk -F= '/^AGENT_BOOTSTRAP_TOKEN=/{print $2}' "${ENV_FILE}" | tail -n 1)"
runtime_token="$(awk -F= '/^AGENT_RUNTIME_TOKEN=/{print $2}' "${ENV_FILE}" | tail -n 1)"

if [[ -z "${manager_url}" || "${manager_url}" == "https://mqttmgmt.example.com" ]]; then
  read -r -p "Manager API URL: " manager_url
  if [[ -n "${manager_url}" ]]; then
    set_env_value "${ENV_FILE}" "MANAGER_API_URL" "${manager_url}"
  fi
fi

if [[ -n "${agent_id}" && ( -n "${bootstrap_token}" || -n "${runtime_token}" ) ]]; then
  systemctl restart rectrix-agent.service
  echo "Rectrix agent installed and started."
  exit 0
fi

if [[ -z "${activation_code}" ]]; then
  read -r -p "24-character Rectrix activation code from email: " activation_code
  activation_code="$(printf '%s' "${activation_code}" | tr '[:lower:]' '[:upper:]')"
  if [[ -n "${activation_code}" ]]; then
    set_env_value "${ENV_FILE}" "AGENT_ACTIVATION_CODE" "${activation_code}"
  fi
fi

if [[ "${activation_code}" =~ ^[A-Z0-9]{24}$ ]]; then
  systemctl restart rectrix-agent.service
  echo "Rectrix agent installed and started."
  exit 0
fi

echo "Agent installed but not started because ${ENV_FILE} is missing a valid 24-character activation code from Rectrix or direct bootstrap credentials."
