# Rectrix Agent Versioning

`rectrix-agent` uses a four-part numeric version scheme:

`YYYY.MM.MMM.NNN`

- `YYYY`: four-digit calendar year.
- `MM`: two-digit calendar month.
- `MMM`: three-digit major build number for that year/month.
- `NNN`: three-digit minor build number for that year/month and major build.

Current example:

- `2026.05.000.001`

Meaning:

- `2026`: released in 2026.
- `05`: released in May.
- `000`: first major build line for May 2026.
- `001`: first minor build in that major line.

## Default bump rule

Unless explicitly requested otherwise, every code change uses a minor version bump.

Example:

- `2026.05.000.001`
- `2026.05.000.002`
- `2026.05.000.003`

## When to bump the major build

Only bump `MMM` when you intentionally want a major build change.

Example:

- previous: `2026.05.000.007`
- next major: `2026.05.001.000`

After that, minor changes continue from the new major line:

- `2026.05.001.001`
- `2026.05.001.002`

## When the month changes

When moving into a new month, reset both build counters unless a different release rule is explicitly requested.

Example:

- last May build: `2026.05.001.014`
- first June build: `2026.06.000.001`

## Files that must be updated

When the agent version changes, update these files together:

- `package.json`
- `package-lock.json`
- `config/agent.example.env`

The runtime reads `AGENT_VERSION` from the environment first and otherwise falls back to the package version.

## Standard operating rule

- Minor code change: increment `NNN`.
- Major build change only when explicitly requested: increment `MMM` and reset `NNN`.
- New month: move `MM` forward and reset to `MMM=000`, `NNN=001` unless instructed otherwise.
