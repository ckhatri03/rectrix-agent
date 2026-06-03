# Changelog

## 2026-06-02

- Added a read-only `dynsec.snapshot` rectrix-agent job that runs `mosquitto_ctrl` against the broker and returns live dynsec users, roles, default ACL access, and role/client details for deeper verification.
- Bumped the published agent version to `2026.06.000.016`.

- Fixed dynsec client creation to pass the MQTT password directly to `mosquitto_ctrl dynsec createClient -p`, avoiding the interactive password prompt that blocked endpoint creation on remote agents.
- Removed the redundant follow-up `setClientPassword` step because the client password is now set during creation.
- Bumped the published agent version to `2026.06.000.015`.

- Added bounded execution time for privileged broker reconcile commands so a hanging `mosquitto_ctrl` dynsec step fails the job instead of blocking the agent queue forever.
- Added client-specific dynsec reconciliation errors so endpoint-create failures identify the exact client step that timed out or returned stderr.
- Bumped the published agent version to `2026.06.000.014`.

- Fixed the generated self-update helper script to emit newline-normalization code as discrete JS lines, avoiding invalid regex/string output in the staged updater file.
- Bumped the published agent version to `2026.06.000.013`.

- Replaced the fragile inline `python3 -c` env rewrite in `agent.update` with a temp helper script plus `sudo install`, eliminating shell-quoting breakage during self-update.
- Bumped the published agent version to `2026.06.000.012`.

- Replaced the self-update `AGENT_VERSION` rewrite with a sudo-backed Python file rewrite so updates no longer fail on root-owned `/etc/rectrix-agent` directories.
- Bumped the published agent version to `2026.06.000.011`.

- Forced `agent.update` to install devDependencies during self-update builds so production agents still have `tsc` available while rebuilding the downloaded release.
- Bumped the published agent version to `2026.06.000.010`.

- Included the self-update shell log tail in `agent.update` failure errors so remote update issues surface the real failing step immediately.
- Bumped the published agent version to `2026.06.000.009`.

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
