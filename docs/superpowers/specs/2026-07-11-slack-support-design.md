# Slack Delivery Support

**Date:** 2026-07-11
**Status:** Approved
**Depends on:** `2026-07-11-github-auth-design.md` (module restructure and
destination interface land there)

## Overview

Add Slack as a second digest destination via a Slack incoming webhook. Discord
and Slack are each optional: the script posts to whichever webhooks are
configured, and requires at least one.

## Goals

- Post the digest to a Slack channel, visually equivalent to the Discord embed.
- Keep destinations independent: one failing doesn't block the other.
- Zero new dependencies; the Slack module implements the same destination
  interface as Discord (`buildPayload(digest)` + `post(url, payload)`).

## Non-Goals

- Slack bot tokens / `chat.postMessage` (webhook only — one channel, no
  threading, which a daily digest doesn't need).
- Per-destination content differences; both render the same digest.

## Configuration

- New optional env var `SLACK_WEBHOOK_URL`, sourced from a repo secret of the
  same name in the workflow.
- The orchestrator's existing "at least one destination" validation now has two
  webhooks to satisfy it. Setting only `SLACK_WEBHOOK_URL` gives Slack-only;
  setting both fans out to both.

## Message format (`lib/slack.mjs`)

Block Kit layout mirroring the Discord embed:

1. **`header` block** — plain text `{username} — {date}`, date pinned to
   `America/New_York` exactly like the Discord title.
2. **`context` block** — mrkdwn `{eventCount} events across {repoCount} repos`.
3. **One `section` block per repo with commits** — mrkdwn:
   ```
   *🟢 `repo` — N commits*
   > `sha` message
   > `sha` message
   ```
4. **`section` blocks for PRs, Issues, Other** (each only if non-empty), with
   bold headers (*🟣 Pull requests*, *🟡 Issues*, *📦 Other*) and one line per
   item, matching the Discord field content.

### Slack-specific requirements

- **Escaping:** Slack mrkdwn treats `&`, `<`, `>` as control characters. All
  user-derived text (commit messages, PR/issue titles, repo names, ref names)
  must be escaped: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`. (Discord needs no
  such escaping — this lives in the Slack formatter only.)
- **Section text limit:** 3,000 characters. Truncate a repo's commit list with a
  `_...and N more_` line, same strategy the Discord formatter uses at its
  1,000-char field limit.
- **Block limit:** 50 blocks per message. Header + context leave room for 48
  sections; if the digest would exceed that, collapse the remaining repos into a
  final section reading `_...and N more repos with activity_`.
- **Header text limit:** 150 characters (username + date fits comfortably; no
  handling needed beyond noting it).

## Posting and error handling

- `post()` sends `POST` with `Content-Type: application/json`. Slack returns
  `200` with body `ok` on success; on failure a 4xx with a short error body
  (e.g. `invalid_blocks`). Non-2xx → throw with status and body text.
- The orchestrator already logs per-destination failures and continues; a Slack
  failure with a Discord success still posts to Discord and exits 1.

## Workflow and README changes

- Workflow: add `SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}` to the env
  block (empty when the secret is unset → treated as not configured).
- README: Slack setup steps (create a Slack app → enable Incoming Webhooks →
  add webhook to the target channel → copy URL into the `SLACK_WEBHOOK_URL`
  secret), update the config table, and reword setup to say "configure Discord,
  Slack, or both."

## Verification

Manual, against a throwaway Slack channel:

1. `SLACK_WEBHOOK_URL=... LOOKBACK_DAYS=7 node digest.mjs` (no Discord URL) →
   digest appears in Slack with header, counts, and per-repo commit sections.
2. Both webhooks set → both channels receive the digest.
3. A commit message containing `<`, `>`, `&` renders literally in Slack (no
   broken link syntax).
4. Invalid Slack webhook URL with valid Discord URL → Discord post succeeds,
   run logs the Slack failure and exits 1.
5. Neither webhook set → validation error, exit 1.
