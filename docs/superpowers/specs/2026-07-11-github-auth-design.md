# Private Repo Support via GitHub PAT (+ Module Restructure)

**Date:** 2026-07-11
**Status:** Approved

## Overview

The digest currently calls the GitHub API unauthenticated, so it only sees public
activity. This change adds optional Personal Access Token (PAT) authentication so
private repo activity (events, commits, PR/issue titles) appears in the digest.

It also restructures the single-file script into an orchestrator plus modules with
explicit source/destination interfaces. This restructure is the foundation for the
Slack destination (see `2026-07-11-slack-support-design.md`) and for any future
source (GitLab, Gitea) or destination someone wants to slot in.

## Goals

- Include private repo activity in the digest when a token is configured.
- Remain fully backward compatible: no token → current public-only behavior.
- Split the code into modules with clean interfaces: sources fetch, destinations
  format and post, the orchestrator wires them together.
- Keep zero runtime dependencies.

## Non-Goals

- GitHub App or OAuth flows (PAT only).
- Actually implementing alternate sources/destinations — the interfaces just make
  them possible.
- Multi-user digests.

## Architecture

```
digest.mjs            orchestrator: config, validation, wiring, exit code
lib/github.mjs        source: all GitHub API calls → neutral digest object
lib/discord.mjs       destination: buildPayload(digest) + post(url, payload)
```

### Source interface

A source module exports one function:

```js
fetchActivity({ username, token, since }) → Promise<Digest>
```

`token` is optional; when absent the source works unauthenticated. A future
GitLab/Gitea source implements the same signature and returns the same shape.

### The neutral Digest shape

Destination-neutral, structured data — no markup. Formatters own all rendering
(backticks, bold, emoji), so a new destination never has to parse strings.

```js
{
  username,                 // string
  eventCount,               // number — total tracked events
  repoCount,                // number — distinct repos with activity
  pushes: {                 // repo short name → deduped commits
    [repo]: [{ sha, message }]
  },
  prs:    [{ repo, action, number, title }],
  issues: [{ repo, action, number, title }],
  other:  [{ repo, description }]   // releases, branch/repo creation, etc.
}
```

`description` in `other` is plain text (e.g. `released v1.2.0: Big fixes`,
`created branch feature-x`); the repo name is carried separately so formatters
can style it.

### Destination interface

A destination module exports two functions:

```js
buildPayload(digest) → object      // service-specific JSON body
post(webhookUrl, payload) → Promise<void>  // throws on non-2xx with status + body
```

### Orchestrator (`digest.mjs`)

1. Read env config: `GITHUB_USERNAME` (required), `GITHUB_TOKEN` (optional),
   `DISCORD_WEBHOOK_URL` (optional), `SLACK_WEBHOOK_URL` (optional),
   `LOOKBACK_DAYS` (default 1). Empty-string env values are treated as unset.
2. Validate: `GITHUB_USERNAME` set, and at least one destination webhook set.
   Otherwise print which variables are missing and exit 1.
3. Build the destination list from configured webhooks (Discord today; Slack
   added by the follow-up spec).
4. `fetchActivity(...)`; if `eventCount === 0`, log the skip message and exit 0
   (current behavior).
5. For each destination: `buildPayload` then `post`. A failure in one destination
   is logged and does not stop the others.
6. Exit 1 if any destination failed, else 0.

## Authentication behavior (`lib/github.mjs`)

- When `token` is provided, every GitHub API request (events, commits, PR/issue
  titles) includes `Authorization: Bearer <token>`.
- No endpoint changes: `/users/{username}/events` automatically includes private
  events when the token belongs to that same user. Commit and title fetches on
  private repos succeed via the same header.
- Rate limit rises from 60 to 5,000 requests/hour as a side benefit.

### Error handling

- **401/403 on the events fetch** (the first call): throw with a clear message —
  "GitHub auth failed (401): token invalid or expired" — so the run exits 1
  instead of silently posting an empty digest. Distinguish 403 rate-limit
  responses (check `x-ratelimit-remaining: 0`) with their own message.
- **Errors on per-repo commit/title fetches**: warn and continue, as today. A
  fine-grained token without access to one repo shouldn't kill the whole digest.

## Workflow changes (`.github/workflows/daily-digest.yml`)

```yaml
env:
  GITHUB_USERNAME: TekGadgt
  GITHUB_TOKEN: ${{ secrets.GH_PAT }}        # optional — private repo support
  DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
  LOOKBACK_DAYS: ${{ github.event.inputs.lookback_days || '1' }}
```

An unset `GH_PAT` secret yields an empty string, which the script treats as
"no token" — the workflow works with or without the secret.

## README changes

- Setup section for the PAT: create a **classic PAT with `repo` scope** at
  github.com/settings/tokens, store it as the `GH_PAT` repo secret. Note that
  fine-grained tokens have patchy Events API support, so classic is recommended;
  note the token expiration date means occasional rotation.
- **Privacy note:** with a token configured, private repo names and commit
  messages are posted to your chat channels — make sure those channels are
  appropriately private.
- Update the "copy these files" instructions to include the `lib/` directory.
- Update the config table with `GITHUB_TOKEN` / `GH_PAT`.

## Verification

No test framework (project is intentionally dependency-free); verify manually:

1. `GITHUB_USERNAME=... LOOKBACK_DAYS=7 node digest.mjs` with `DISCORD_WEBHOOK_URL`
   pointed at a throwaway channel and **no token** → output matches current
   behavior (public activity only).
2. Same run **with** `GITHUB_TOKEN` set to a valid PAT → digest includes private
   repo activity.
3. Run with a deliberately invalid token → clear auth error, exit code 1, no post.
4. Run with no webhook configured → validation error naming the missing variable.
