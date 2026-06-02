# CraftRFP Status Data

This public repository stores compact uptime JSON for the CraftRFP public status page. GitHub
Actions runs `scripts/check.mjs` about every five minutes, probes `https://craftrfp.com`, and
commits updated `summary.json` plus `history/*.json` files. GitHub Pages can serve those files as
the app's `STATUS_DATA_URL`.

## Setup

1. Keep this repository public. Public GitHub Actions and Pages are used intentionally for the
   status data pipeline.
2. Add the Actions secret `STATUS_PROBE_SECRET`. It must match the app's Vercel
   `STATUS_PROBE_SECRET`; it is the only secret used here.
3. Enable GitHub Pages for the repository root. The resulting Pages URL becomes the CraftRFP app's
   `STATUS_DATA_URL`.

`BASE_URL` can be overridden with a repository variable or local environment variable. Production
defaults to `https://craftrfp.com`.

## Data

- `summary.json` is the current snapshot consumed by `/status`.
- `history/<service>.json` stores up to 90 UTC daily buckets for `marketing`, `api`, `db`, `scribe`,
  `exports`, and `auth`.
- `history/.raw/<service>.json` stores a rolling check ring used to recompute 24-hour and 90-day
  uptime. The public contract files stay schema-clean; raw files are implementation detail.

Uptime percentages count only `up` checks as available. A day status is the worst check observed
that UTC day: `down` beats `degraded`, which beats `up`.

GitHub scheduled workflows are best-effort and can drift by 5-15 minutes. This repository is for
status-page-grade visibility, not an SLA measurement system.

## Local Check

```bash
STATUS_PROBE_SECRET=example node scripts/check.mjs
```
