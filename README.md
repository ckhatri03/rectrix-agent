# Rectrix Agent

`rectrix-agent` is the public edge deployment agent for Rectrix-managed remote
Ubuntu VMs.

The agent is designed for the deployment model where:

- the private Rectrix app remains the control plane
- the remote VM agent is the execution plane
- the agent uses outbound connectivity only
- Mosquitto and Telegraf changes are applied locally through typed jobs
- direct app-to-VM SSH is removed from the long-term operating path

## Current Scope

This initial version supports:

- activation against a private manager API
- enrollment, heartbeat, and capability reporting
- polling for queued deployment jobs
- typed handlers for:
  - `stack.install`
  - `stack.remove`
  - `broker.config.apply`
  - `mosquitto.acl.sync`
  - `telegraf.apply`
  - `telegraf.remove`

## Install

Bootstrap from the public repo:

```bash
curl -fsSL https://raw.githubusercontent.com/ckhatri03/rectrix-agent/main/scripts/install.sh | sudo bash
```

The installer:

- creates the `rectrix-agent` service user
- installs the app under `/opt/rectrix-agent/app`
- installs `/etc/systemd/system/rectrix-agent.service`
- creates `/etc/rectrix-agent/agent.env` if missing
- creates a restricted sudoers file for package, file, and systemd operations

After install, update `/etc/rectrix-agent/agent.env` with your manager URL and
either activation credentials or direct bootstrap credentials.

The installer only auto-starts the service when the env file already contains:

- `MANAGER_API_URL`, and
- either activation credentials or direct bootstrap credentials

## Runtime Configuration

See [config/agent.example.env](config/agent.example.env).

Minimum fresh-install configuration:

```env
MANAGER_API_URL=https://mqttmgmt.example.com
ACTIVATION_USER_ID=customer-123
ACTIVATION_LICENSE_KEY=LIC-XXXX-XXXX
```

Direct bootstrap configuration:

```env
MANAGER_API_URL=https://mqttmgmt.example.com
AGENT_ID=agt_01
AGENT_BOOTSTRAP_TOKEN=boot_xxx
```

## Default Manager API Paths

The agent assumes these default paths, all of which are configurable:

- `POST /public-agent/activate`
- `POST /agent/enroll`
- `POST /agent/heartbeat`
- `POST /agent/capabilities`
- `POST /agent/jobs/next`
- `POST /agent/jobs/:jobId/events`
- `POST /agent/jobs/:jobId/complete`

## Job Payloads

### `stack.install`

```json
{
  "packages": ["mosquitto", "telegraf"],
  "packageVersions": {
    "mosquitto": "2.0.18-0ubuntu0.22.04.1"
  },
  "unitsToEnable": ["mosquitto.service", "telegraf.service"],
  "unitsToStart": ["mosquitto.service", "telegraf.service"]
}
```

### `broker.config.apply`

```json
{
  "installPackages": true,
  "packages": ["mosquitto"],
  "files": [
    {
      "path": "/etc/mosquitto/conf.d/site-a.conf",
      "content": "listener 8883\nallow_anonymous false\n",
      "mode": "0644"
    }
  ],
  "unitsToRestart": ["mosquitto.service"]
}
```

### `mosquitto.acl.sync`

```json
{
  "files": [
    {
      "path": "/etc/mosquitto/acl/site-a.acl",
      "content": "user site-a\npattern readwrite sensors/#\n",
      "mode": "0640"
    }
  ],
  "unitsToReload": ["mosquitto.service"]
}
```

### `telegraf.apply`

```json
{
  "installPackages": true,
  "packages": ["telegraf"],
  "files": [
    {
      "path": "/etc/telegraf/telegraf.d/site-a.conf",
      "content": "[[inputs.mqtt_consumer]]\nservers = [\"ssl://broker.example.com:8883\"]\n",
      "mode": "0644"
    }
  ],
  "unitsToRestart": ["telegraf.service"]
}
```

### `telegraf.remove`

```json
{
  "filesToRemove": ["/etc/telegraf/telegraf.d/site-a.conf"],
  "unitsToStop": ["telegraf.service"],
  "unitsToDisable": [],
  "removePackages": false
}
```

## Development

```bash
npm ci
npm run build
npm run dev
```

Node `20+` is required.

## Security Model

The agent does not expose a generic remote shell and does not accept arbitrary
command execution jobs.

Guardrails in this repo:

- managed file writes are limited to configured roots
- systemd operations are limited to approved unit name patterns
- package operations are limited to `mosquitto` and `telegraf`
- the service runs as `rectrix-agent` and escalates only through constrained
  `sudo`

## Repository Policy

This repository is public for distribution and inspection of the official
Rectrix agent only.

- external code changes are not accepted
- public visibility does not grant modification or redistribution rights
- official updates are maintained only by the repository owner

See [LICENSE](LICENSE), [DISCLAIMER.md](DISCLAIMER.md), and
[CONTRIBUTING.md](CONTRIBUTING.md).

Third-party software, standards, and brands referenced by this repository,
including Eclipse Mosquitto, Telegraf, MQTT, and Ubuntu, remain subject to
their own upstream copyrights, licenses, and trademark policies.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

This software can install packages, write configuration, and restart services
on a remote Ubuntu VM. Validate it in a controlled environment before using it
in production.

Do not rely on this software as the sole safeguard for high-risk, safety
critical, medical, or emergency systems.

## License

This repository is source-available but not open source. All rights are
reserved unless the copyright holder grants written permission.
