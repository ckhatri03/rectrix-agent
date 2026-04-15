#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "uninstall.sh must run as root" >&2
  exit 1
fi

systemctl disable --now rectrix-agent.service 2>/dev/null || true
rm -f /etc/systemd/system/rectrix-agent.service
rm -f /etc/sudoers.d/rectrix-agent
systemctl daemon-reload

echo "Rectrix agent service removed."
echo "Preserved:"
echo "  /opt/rectrix-agent"
echo "  /etc/rectrix-agent"
echo "  /var/lib/rectrix-agent"

