# Disclaimer

`rectrix-agent` is infrastructure software intended for controlled deployment on
Ubuntu hosts managed by Rectrix-compatible control-plane services.

By using this software, you acknowledge and accept all of the following:

- the software may install packages, write configuration files, and restart
  systemd services
- the installer may establish constrained elevated access for the agent service
- incorrect configuration can interrupt Mosquitto, Telegraf, or related host
  services
- you are responsible for validating the software in a non-production or pilot
  environment before wider rollout
- you are responsible for ensuring compliance with your own operational,
  security, and regulatory requirements

This repository and its contents:

- are provided without any promise of fitness for a specific environment
- may change without notice
- should not be relied on as the sole control or safety mechanism for
  life-safety, medical, emergency, or other high-risk systems

Use of this software is at your own risk.

Third-party components and names referenced by this repository, including
Eclipse Mosquitto, Telegraf, MQTT, and Ubuntu, remain subject to their own
upstream copyrights, licenses, standards terms, and trademark policies. This
repository does not claim ownership over those third-party rights.
