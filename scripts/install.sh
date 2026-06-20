#!/usr/bin/env bash
set -euo pipefail

TTY_FD=""

open_tty() {
  if [[ -n "${TTY_FD}" ]]; then
    return 0
  fi

  if exec {TTY_FD}<>/dev/tty; then
    return 0
  fi

  TTY_FD=""
  return 1
}

prompt_value() {
  local prompt="$1"
  local current_value="${2:-}"
  local result=""

  if [[ -n "${current_value}" ]]; then
    printf '%s' "${current_value}"
    return 0
  fi

  if ! open_tty; then
    echo "Installer requires terminal input for: ${prompt}" >&2
    echo "Set the required values in ${ENV_FILE} before using the curl-piped installer, or download and run the script directly." >&2
    exit 1
  fi

  read -r -u "${TTY_FD}" -p "${prompt}" result
  printf '%s' "${result}"
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

REPO_OWNER="${REPO_OWNER:-ckhatri03}"
REPO_NAME="${REPO_NAME:-rectrix-agent}"
REPO_REF="${REPO_REF:-main}"
PUBLIC_AGENT_BASE_URL="${PUBLIC_AGENT_BASE_URL:-https://manager-prod.sensorlog.io}"
PUBLIC_AGENT_BASE_URL="${PUBLIC_AGENT_BASE_URL%/}"
SERVICE_USER="${SERVICE_USER:-rectrix-agent}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/rectrix-agent}"
APP_DIR="${INSTALL_ROOT}/app"
STATE_DIR="${STATE_DIR:-/var/lib/rectrix-agent}"
ENV_DIR="${ENV_DIR:-/etc/rectrix-agent}"
ENV_FILE="${ENV_FILE:-${ENV_DIR}/agent.env}"
LOG_FILE="${LOG_FILE:-/var/log/rectrix-agent.log}"
SYSTEMD_UNIT_DEST="${SYSTEMD_UNIT_DEST:-/etc/systemd/system/rectrix-agent.service}"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/rectrix-agent}"
ARCHIVE_URL="${ARCHIVE_URL:-${PUBLIC_AGENT_BASE_URL}/public-agent/releases/latest/archive}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

version_ge() {
  local current="$1"
  local required="$2"

  [[ "$(printf '%s\n%s\n' "${required}" "${current}" | sort -V | head -n 1)" == "${required}" ]]
}

detect_os() {
  local id_like=""

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    printf '%s|%s\n' "${ID:-}" "${ID_LIKE:-}"
    return 0
  fi

  printf '|\n'
}

install_nodejs_20_debian() {
  local os_info
  local os_id
  local os_like
  local node_major="${NODE_MAJOR_VERSION:-20}"
  local keyring_dir="/etc/apt/keyrings"
  local keyring_file="${keyring_dir}/nodesource.gpg"
  local source_list="/etc/apt/sources.list.d/nodesource.list"
  local arch

  os_info="$(detect_os)"
  os_id="${os_info%%|*}"
  os_like="${os_info#*|}"

  case " ${os_id} ${os_like} " in
    *" ubuntu "*|*" debian "*)
      ;;
    *)
      echo "Automatic Node.js installation is only supported on Ubuntu/Debian. Install Node.js >= ${node_major} manually and rerun the installer." >&2
      exit 1
      ;;
  esac

  export DEBIAN_FRONTEND=noninteractive

  apt-get update
  apt-get install -y ca-certificates curl gnupg

  mkdir -p "${keyring_dir}"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o "${keyring_file}"
  chmod 0644 "${keyring_file}"

  arch="$(dpkg --print-architecture)"
  cat > "${source_list}" <<EOF
deb [arch=${arch} signed-by=${keyring_file}] https://deb.nodesource.com/node_${node_major}.x nodistro main
EOF

  apt-get update
  apt-get install -y nodejs
}

ensure_node_runtime() {
  local required_major="${NODE_MAJOR_VERSION:-20}"
  local required_version="${required_major}.0.0"
  local current_version=""

  if command -v node >/dev/null 2>&1; then
    current_version="$(node -v 2>/dev/null | sed 's/^v//')"
  fi

  if [[ -n "${current_version}" ]] && version_ge "${current_version}" "${required_version}" && command -v npm >/dev/null 2>&1; then
    return 0
  fi

  if [[ -n "${current_version}" ]]; then
    echo "Detected Node.js ${current_version}; upgrading to Node.js >= ${required_major}." >&2
  else
    echo "Node.js >= ${required_major} is required; installing it now." >&2
  fi

  install_nodejs_20_debian

  require_cmd node
  require_cmd npm

  current_version="$(node -v 2>/dev/null | sed 's/^v//')"
  if [[ -z "${current_version}" ]] || ! version_ge "${current_version}" "${required_version}"; then
    echo "Installed Node.js version ${current_version:-unknown} does not satisfy >= ${required_version}." >&2
    exit 1
  fi
}

require_cmd curl
require_cmd tar
require_cmd systemctl
ensure_node_runtime

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

apply_agent_env_override() {
  local key="$1"
  local value="${!key:-}"

  if [[ -z "${value}" ]]; then
    return 0
  fi

  if [[ "${key}" == "AGENT_ACTIVATION_CODE" ]]; then
    value="$(printf '%s' "${value}" | tr '[:lower:]' '[:upper:]')"
  fi

  set_env_value "${ENV_FILE}" "${key}" "${value}"
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
package_version="$(node -p "require('./package.json').version")"
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

set_env_value "${ENV_FILE}" "AGENT_VERSION" "${package_version}"

if [[ ! -f "${LOG_FILE}" ]]; then
  install -m 0640 -o "${SERVICE_USER}" -g "${SERVICE_USER}" /dev/null "${LOG_FILE}"
else
  chown "${SERVICE_USER}:${SERVICE_USER}" "${LOG_FILE}" || true
  chmod 0640 "${LOG_FILE}" || true
fi

for key in \
  AGENT_VERSION \
  LOG_LEVEL \
  MANAGER_API_URL \
  WSS_URL \
  CONTROL_PLANE_MODE \
  CONTROL_PLANE_AUTH_MODE \
  AGENT_ACTIVATION_CODE \
  AGENT_ID \
  AGENT_BOOTSTRAP_TOKEN \
  AGENT_RUNTIME_TOKEN \
  POLL_INTERVAL_MS \
  HEARTBEAT_INTERVAL_MS \
  WSS_PING_INTERVAL_MS \
  WSS_BACKOFF_INITIAL_MS \
  WSS_BACKOFF_MAX_MS \
  CERTBOT_BIN
do
  apply_agent_env_override "${key}"
done

cat > "${SUDOERS_FILE}" <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/apt-get, /usr/bin/certbot, /usr/bin/install, /usr/bin/rm, /usr/bin/journalctl, /usr/bin/chown, /usr/bin/chmod, /usr/bin/setfacl, /usr/bin/mosquitto_ctrl, /usr/bin/mosquitto_sub, /usr/bin/python3
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
  manager_url="${PUBLIC_AGENT_BASE_URL}"
  set_env_value "${ENV_FILE}" "MANAGER_API_URL" "${manager_url}"
fi

if [[ -n "${agent_id}" && ( -n "${bootstrap_token}" || -n "${runtime_token}" ) ]]; then
  systemctl restart rectrix-agent.service
  echo "Rectrix agent installed and started."
  exit 0
fi

if [[ -z "${activation_code}" ]]; then
  activation_code="$(prompt_value "24-character Rectrix activation code from email: " "${activation_code}")"
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
