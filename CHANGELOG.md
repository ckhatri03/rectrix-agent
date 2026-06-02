# Changelog

## 2026-06-02

- Made `agent.update` validate the archive download, install, and version-file swap before reporting success, so failed self-updates surface as failed jobs instead of false positives.
- Bumped the published agent version to `2026.06.000.008`.

- Fixed per-broker Mosquitto dynsec state directory ownership so the broker can persist dynamic-security updates after startup reconciliation.
- Bumped the published agent version to `2026.06.000.007`.

- Switched manager-driven self-update to pull the public GitHub archive so edge hosts track the published `main` release instead of the manager-local repo snapshot, and made installer upgrades always refresh `AGENT_VERSION`.
- Bumped the published agent version to `2026.06.000.006`.
- Moved per-broker Mosquitto dynsec state from `/etc/mosquitto/dynamic-security` into each broker's `/var/lib/mosquitto/<service>` data directory so the plugin can persist changes on remote agents without runtime write failures.
- Fixed dynsec broker apply on remote agents by allowing plugin discovery under system library paths outside managed config roots.
- Made DNS-01 certificate deployment skip missing broker service units so cert jobs do not fail before the broker unit exists.
- Bumped the published agent version to `2026.06.000.005`.

- Switched broker authentication and ACL reconciliation from Mosquitto password and ACL files to Mosquitto Dynamic Security managed through `mosquitto_ctrl`.
- Removed remaining file-based MQTT auth cleanup from the public agent install and uninstall flows, including obsolete `mosquitto_passwd` sudo access.
- Bumped the published agent version to `2026.06.000.001`.

## 2026-06-01

- Added ACL file handling to broker apply jobs so rectrix-agent now writes Mosquitto config, password file, and ACL file together during a single broker reconcile.
- Kept the generated broker runtime aligned with secure MQTT deployments by honoring the manager-supplied `acl_file` directive and ACL payload during apply.
- Bumped the published agent version to `2026.05.000.022`.

## 2026-05-22

- Added terminal activation failure handling so expired, revoked, and already-used activation codes stop retrying on the agent side, persist a disabled activation reason, and clear stale activation credentials from the agent env file.
- Added an idle HTTP job-poll cooldown in `src/agent.ts` and new config knobs in `src/config.ts` so agents slow `/agent/jobs/next` polling after 15 minutes with no jobs while leaving heartbeat cadence unchanged.
- Verified the updated TypeScript build after the activation guardrail and idle polling changes.

## 2026-04-16

- Quoted shell-sensitive persisted environment values in `src/envFile.ts` so
  agent-written env files remain valid when values contain regex metacharacters
  and similar shell-sensitive content.
- Quoted `ALLOWED_UNIT_PATTERNS` in `config/agent.example.env` so fresh installs
  keep the intended unit allowlist instead of breaking env parsing on first
  bootstrap.
- Verified the public installer flow against the registered pilot VM through
  `https://mqttmgmt.sensorlog.io`, including clean uninstall, fresh enrollment,
  heartbeat, and a successful `agent.diagnostics.snapshot` job.
