# Security

## Supported versions

Throughline is pre-1.0. Only the latest `main` is supported — there are no maintained release branches. If you found a problem in an older checkout, reproduce it on `main` first.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the **Security** tab on [github.com/tgurgick/tl](https://github.com/tgurgick/tl) → **Report a vulnerability**. If that path is unavailable to you, open a regular issue that says "security — requesting a private channel" **without** exploit details, and a private channel will be arranged.

This is a personal tool, not a company. Reports get read and taken seriously; fixes land on `main`. There is no formal SLA or bounty program.

## Threat model, in brief

What Throughline assumes and what it doesn't:

- **Single local user.** The UI server binds `127.0.0.1` and has **no auth** — any process on your machine can reach it. Its POST write surface is deliberately small, and every write is path-confined to the workspace (`safePath`) and field-scoped (`lib/frontmatter`), but localhost is the trust boundary. Don't port-forward or reverse-proxy the UI to anything shared.
- **Agents execute code.** Headless lanes and experiment runs invoke agent CLIs that run real commands. Experiment candidates run in disposable **git worktrees** — that's isolation of the canonical working tree (a candidate can't mutate your checkout), **not a security sandbox**. Actual sandboxing — filesystem and network limits on what the agent process may do — comes from the agent CLI's own flags and profiles (e.g. codex's `--sandbox workspace-write`); `docs/headless-lanes.md` documents the per-lane posture.
- **Workspaces are private data.** Everything under `projects/` is gitignored. Keep it that way — specs and threads routinely contain things that don't belong in a public repo.

Findings that break one of those confinement claims — a UI write escaping the workspace, a candidate run mutating the canonical tree — are exactly what the reporting path above is for.
