# GitHub Discord Digest

A zero-dependency GitHub Action that posts your daily GitHub activity to a Discord channel via webhook.

## Setup

1. **Create a Discord webhook**
   - In your Discord server, go to the channel → Edit → Integrations → Webhooks
   - Create a new webhook, copy the URL

2. **Create a repo** (or add to an existing one)
   - Copy `.github/workflows/daily-digest.yml` and `digest.mjs` into your repo

3. **Add the secret**
   - Repo → Settings → Secrets and variables → Actions
   - Add `DISCORD_WEBHOOK_URL` with your webhook URL

4. **Test it**
   - Go to Actions → "Daily GitHub Digest" → Run workflow

## Config

| Variable | Where | Default |
|---|---|---|
| `GITHUB_USERNAME` | workflow env | `TekGadgt` |
| `DISCORD_WEBHOOK_URL` | repo secret | — |
| Cron schedule | workflow file | `0 13 * * *` (9 AM ET) |

## What it tracks

Pushes (with commit messages), pull requests, issues, releases, branch/repo creation. Skips stars, forks, and watches.

## What it skips

If you had no tracked activity in the last 24h, it silently skips — no empty posts.
