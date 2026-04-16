# Changelog

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
