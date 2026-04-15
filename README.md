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
- steady-state control over:
  - `http`
  - `rest` alias for `http`
  - `wss`
  - `auto` startup selection with `wss -> http` fallback
- polling for queued deployment jobs in HTTP mode
- pushed job dispatch in WSS mode
- typed handlers for:
  - `agent.diagnostics.snapshot`
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
- prompts for the Rectrix-issued 24-character activation code during install
  when direct bootstrap credentials are not already present
- expects that activation code to be supplied separately by Rectrix, for
  example by customer email

After install, update `/etc/rectrix-agent/agent.env` with your manager URL and
either the Rectrix-issued activation code or direct bootstrap credentials.

The installer only auto-starts the service when the env file already contains:

- `MANAGER_API_URL`, and
- either a valid 24-character activation code or direct bootstrap credentials

For automated or SSH-driven installs, the installer also honors agent runtime
environment overrides passed to the root shell. Example:

```bash
curl -fsSL https://raw.githubusercontent.com/ckhatri03/rectrix-agent/main/scripts/install.sh \
  | sudo env \
      MANAGER_API_URL=https://mqttmgmt.example.com \
      AGENT_ACTIVATION_CODE=ABCD1234EFGH5678IJKL9012 \
      CONTROL_PLANE_MODE=http \
      LOG_LEVEL=debug \
      bash
```

## Runtime Configuration

See [config/agent.example.env](config/agent.example.env).

Minimum fresh-install configuration:

```env
MANAGER_API_URL=https://mqttmgmt.example.com
AGENT_ACTIVATION_CODE=ABCD1234EFGH5678IJKL9012
```

Direct bootstrap configuration:

```env
MANAGER_API_URL=https://mqttmgmt.example.com
AGENT_ID=agt_01
AGENT_BOOTSTRAP_TOKEN=boot_xxx
```

Serverless-ready WSS configuration:

```env
MANAGER_API_URL=https://mqttmgmt.example.com
WSS_URL=wss://agent-control.example.com
CONTROL_PLANE_MODE=auto
CONTROL_PLANE_AUTH_MODE=token
AGENT_ID=agt_01
AGENT_RUNTIME_TOKEN=rt_xxx
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

Activation and enrollment stay on HTTPS. The transport selection above applies
to steady-state capability reporting, presence, job dispatch, job events, and
job completion.

## Control Plane Modes

- `http`: existing REST heartbeat and REST job polling behavior
- `rest`: accepted as an alias for `http`
- `wss`: persistent outbound WebSocket control session; requires `WSS_URL`
- `auto`: try `wss` first, then fall back to `http` on startup

`CONTROL_PLANE_AUTH_MODE=token` is implemented now. `x509` is reserved for the
later certificate phase and will currently fall back in `auto` mode or fail in
forced `wss` mode.

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

### `agent.diagnostics.snapshot`

```json
{
  "note": "staging enrollment check",
  "requestedBy": "agent-e2e-harness",
  "expectedTransportMode": "http"
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

## Activation Flow

Fresh deployment flow:

1. Rectrix sends the user a 24-character alphanumeric activation code in a
   separate email.
2. The installer writes that code to the edge agent env file.
3. The agent exchanges the code for a bootstrap token through
   `POST /public-agent/activate`.
4. The agent enrolls through `POST /agent/enroll`.
5. The manager invalidates the one-time activation code and returns a permanent
   runtime token.
6. The agent saves that permanent runtime token into its own edge env file and
   clears the activation code.

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
