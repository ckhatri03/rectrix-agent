# Rectrix Agent Repo Memory

This file records repository-specific maintenance workflow that should be followed for the public `rectrix-agent` repo.

## Branch workflow

- Always work from `main`.
- Always commit intended public-repo changes on `main`.
- Do not leave work finalized only on a feature branch when the goal is to update the public repo.
- Always update the remote GitHub `main` branch for intended public releases.

## Versioning workflow

- Always bump the minor version when making a commit intended for the public repo.
- Follow `VERSIONING.md`.
- Unless explicitly instructed otherwise, increment the final `NNN` segment.
- When bumping the agent version, update these files together:
  - `package.json`
  - `package-lock.json`
  - `config/agent.example.env`

## Protected main workflow

The `main` branch is protected and uses:

- `required_linear_history: true`
- `enforce_admins: true`
- `lock_branch: true`

To commit and push a release to GitHub `main`, use this sequence with authenticated `gh` access:

1. Prepare the release commit locally on `main`.
2. Confirm the minor version bump is included.
3. Use `gh` with the available GitHub token/auth context to temporarily disable `lock_branch` on `main`.
4. Push the commit to `origin main`.
5. Immediately restore `lock_branch: true` on `main` using `gh`.
6. Verify `main` is locked again after the push.

## Practical note

For this repo, a direct push to `main` may fail even with admin access while the branch is locked. The reliable maintenance sequence is:

1. Keep the working branch on `main`.
2. Make the required code change.
3. Bump the minor version.
4. Commit locally on `main`.
5. Unlock `main` with `gh`.
6. Push to `origin main`.
7. Re-lock `main` with `gh`.
