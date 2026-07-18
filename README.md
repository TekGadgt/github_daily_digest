# GitHub Discord Digest

A zero-dependency GitHub Action that posts your daily GitHub activity to a Discord channel via webhook.

## Setup

1. **Create a Discord webhook**
   - In your Discord server, go to the channel → Edit → Integrations → Webhooks
   - Create a new webhook, copy the URL

2. **Create a repo** (or add to an existing one)
   - Copy `.github/workflows/daily-digest.yml`, `digest.mjs`, and the `lib/` directory into your repo

3. **Add the secret**
   - Repo → Settings → Secrets and variables → Actions
   - Add `DISCORD_WEBHOOK_URL` with your webhook URL

### Private repo support (optional)

To include private repo activity, create a **classic** Personal Access Token with the
`repo` scope at [github.com/settings/tokens](https://github.com/settings/tokens) and add
it as a repo secret named `GH_PAT`. Classic is recommended — fine-grained tokens have
patchy Events API support. Note the token's expiration date; you'll need to rotate it
occasionally.

> **Privacy note:** with a token configured, private repo names and commit messages are
> posted to your chat channels — make sure those channels are appropriately private.

4. **Test it**
   - Go to Actions → "Daily GitHub Digest" → Run workflow

## Config

| Variable | Where | Default |
|---|---|---|
| `GITHUB_USERNAME` | workflow env | `TekGadgt` |
| `GITHUB_TOKEN` | repo secret `GH_PAT` (optional) | — (public activity only) |
| `DISCORD_WEBHOOK_URL` | repo secret | — |
| Cron schedule | workflow file | `0 1 * * *` (9 PM ET) |

## What it tracks

Pushes (with commit messages), pull requests, issues, releases, branch/repo creation. Skips stars, forks, and watches.

## What it skips

If you had no tracked activity in the last 24h, it silently skips — no empty posts.
