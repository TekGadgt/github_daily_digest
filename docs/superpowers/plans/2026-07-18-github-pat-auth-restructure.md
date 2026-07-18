# GitHub PAT Auth + Module Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional GitHub PAT authentication so private repo activity appears in the digest, and restructure the single-file script into an orchestrator + source/destination modules.

**Architecture:** `digest.mjs` becomes a thin orchestrator (env config, validation, wiring, exit codes). `lib/github.mjs` is the source: all GitHub API calls, returning a destination-neutral digest object with no markup. `lib/discord.mjs` is the destination: `buildPayload(digest)` + `post(url, payload)`. Spec: `docs/superpowers/specs/2026-07-11-github-auth-design.md`.

**Tech Stack:** Node.js 24, ES modules (`.mjs`), built-in `fetch`. Zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies — no `package.json`, no test framework; verification is manual `node` commands (per spec).
- Backward compatible: no token → current public-only behavior; no-activity runs log `No activity in the last N day(s). Skipping post.` and exit 0.
- Empty-string env values are treated as unset.
- The neutral digest object contains **no markup** (no backticks/bold/emoji) — formatters own all rendering.
- Auth error message format (verbatim): `GitHub auth failed (401): token invalid or expired` (or `(403)`); rate limit: distinguish 403 with `x-ratelimit-remaining: 0`.
- Workflow env name for the secret is `GH_PAT`, exposed to the script as `GITHUB_TOKEN`.

## Known intentional output changes

The neutral digest shape forces two tiny copy changes in the Discord output (approved by the spec's "no markup in digest" rule):

- Repo creation renders as `` `repo` — created new repo `` (was `` Created new repo `repo` ``).
- Branch/tag creation renders the ref without backticks: `` `repo` — created branch feature-x `` (was `` `repo` — created branch `feature-x` ``).

Everything else renders byte-identical to today.

---

### Task 1: `lib/github.mjs` — the source module

**Files:**
- Create: `lib/github.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `fetchActivity({ username, token, since }) → Promise<Digest>` where `Digest` is:
  ```js
  {
    username,                 // string
    eventCount,               // number — total tracked events
    repoCount,                // number — distinct repos with activity
    pushes: { [repoShort]: [{ sha, message }] },  // deduped by sha
    prs:    [{ repo, action, number, title }],    // title is a string, "untitled" fallback applied
    issues: [{ repo, action, number, title }],
    other:  [{ repo, description }]               // description is plain text, no markup
  }
  ```
  `token` optional; absent → unauthenticated requests (current behavior). Throws `Error` on 401/403 from the events fetch.

- [ ] **Step 1: Write `lib/github.mjs`**

The logic is a direct port of `fetchEvents` / `fetchCommits` / `fetchTitle` / `buildDigest` from the current `digest.mjs` (lines 21–166), with four changes: headers built per-call so `Authorization: Bearer <token>` is added when a token is given; 401/403 on the events fetch throws instead of soft-failing; commit dedupe (currently in `buildEmbed`) moves here; event processing emits structured objects instead of Discord-formatted strings.

```js
// lib/github.mjs — GitHub source: fetches activity, returns a neutral digest object.
// Strategy: Events API for the index (active repos, PRs, issues, releases)
//           Commits API for actual commit data per repo

const TRACKED_TYPES = new Set([
  "PushEvent",
  "PullRequestEvent",
  "IssuesEvent",
  "CreateEvent",
  "DeleteEvent",
  "ReleaseEvent",
]);

function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "github-discord-digest",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchEvents({ username, headers, since }) {
  const events = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(
      `https://api.github.com/users/${username}/events?per_page=100&page=${page}`,
      { headers }
    );
    if (res.status === 401 || res.status === 403) {
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        throw new Error(
          "GitHub rate limit exceeded (403): wait for the limit to reset or configure GITHUB_TOKEN"
        );
      }
      throw new Error(`GitHub auth failed (${res.status}): token invalid or expired`);
    }
    if (!res.ok) {
      console.error(`GitHub Events API error: ${res.status}`);
      break;
    }
    const page_events = await res.json();
    if (page_events.length === 0) break;

    for (const event of page_events) {
      if (new Date(event.created_at) < since) return events;
      if (TRACKED_TYPES.has(event.type)) events.push(event);
    }
  }
  return events;
}

async function fetchCommits({ repoFullName, username, headers, since }) {
  const commits = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const url = `https://api.github.com/repos/${repoFullName}/commits?author=${username}&since=${since.toISOString()}&per_page=100&page=${page}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.warn(`Commits API error for ${repoFullName}: ${res.status}`);
        break;
      }
      const page_commits = await res.json();
      if (page_commits.length === 0) break;

      for (const c of page_commits) {
        const message = (c.commit?.message || "").split("\n")[0].slice(0, 72);
        const sha = c.sha?.slice(0, 7) || "";
        commits.push({ sha, message });
      }
    }
  } catch (err) {
    console.warn(`Failed to fetch commits for ${repoFullName}: ${err.message}`);
  }
  // Dedupe by sha (pagination can repeat commits)
  const seen = new Set();
  return commits.filter((c) => {
    if (seen.has(c.sha)) return false;
    seen.add(c.sha);
    return true;
  });
}

async function fetchTitle({ repoFullName, headers, type, number }) {
  try {
    const endpoint = type === "pr" ? "pulls" : "issues";
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/${endpoint}/${number}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

export async function fetchActivity({ username, token, since }) {
  const headers = buildHeaders(token);
  const events = await fetchEvents({ username, headers, since });

  const repos = new Set(events.map((e) => e.repo.name));
  const pushRepos = new Set();
  const prs = [];
  const issues = [];
  const other = [];

  for (const e of events) {
    const repoShort = e.repo.name.replace(`${username}/`, "");

    try {
      switch (e.type) {
        case "PushEvent":
          pushRepos.add(e.repo.name);
          break;

        case "PullRequestEvent": {
          const pr = e.payload?.pull_request;
          if (!pr) break;
          let title = pr.title;
          if (!title) {
            title = await fetchTitle({
              repoFullName: e.repo.name,
              headers,
              type: "pr",
              number: pr.number,
            });
          }
          prs.push({
            repo: repoShort,
            action: e.payload.action,
            number: pr.number,
            title: title || "untitled",
          });
          break;
        }
        case "IssuesEvent": {
          const issue = e.payload?.issue;
          if (!issue) break;
          let title = issue.title;
          if (!title) {
            title = await fetchTitle({
              repoFullName: e.repo.name,
              headers,
              type: "issue",
              number: issue.number,
            });
          }
          issues.push({
            repo: repoShort,
            action: e.payload.action,
            number: issue.number,
            title: title || "untitled",
          });
          break;
        }
        case "CreateEvent": {
          if (e.payload.ref_type === "repository") {
            other.push({ repo: repoShort, description: "created new repo" });
          } else {
            other.push({
              repo: repoShort,
              description: `created ${e.payload.ref_type} ${e.payload.ref}`,
            });
          }
          break;
        }
        case "ReleaseEvent": {
          const rel = e.payload?.release;
          if (!rel) break;
          other.push({
            repo: repoShort,
            description: `released ${rel.tag_name}: ${rel.name || ""}`,
          });
          break;
        }
      }
    } catch (err) {
      console.warn(`Skipping event ${e.type} in ${repoShort}: ${err.message}`);
    }
  }

  // Fetch real commits for each repo that had push activity
  const pushes = {};
  for (const repoFullName of pushRepos) {
    const repoShort = repoFullName.replace(`${username}/`, "");
    const commits = await fetchCommits({ repoFullName, username, headers, since });
    if (commits.length > 0) {
      pushes[repoShort] = commits;
    }
  }

  return {
    username,
    eventCount: events.length,
    repoCount: repos.size,
    pushes,
    prs,
    issues,
    other,
  };
}
```

- [ ] **Step 2: Smoke-verify the module against the live public API**

Run:

```bash
node -e '
import("./lib/github.mjs").then(async ({ fetchActivity }) => {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const d = await fetchActivity({ username: "TekGadgt", since });
  console.log(JSON.stringify(d, null, 2).slice(0, 2000));
});
'
```

Expected: JSON with `username`, `eventCount`, `repoCount`, `pushes`, `prs`, `issues`, `other` keys. No markup (no backticks) in any string values. If the user had no public activity in 7 days, `eventCount: 0` with empty collections is also a pass.

- [ ] **Step 3: Commit**

```bash
git add lib/github.mjs
git commit -m "feat: extract GitHub source module with optional PAT auth"
```

---

### Task 2: `lib/discord.mjs` — the destination module

**Files:**
- Create: `lib/discord.mjs`

**Interfaces:**
- Consumes: the `Digest` shape from Task 1 (read-only; does not import `lib/github.mjs`).
- Produces: `buildPayload(digest) → object` (Discord webhook JSON body) and `post(webhookUrl, payload) → Promise<void>` (throws `Error` with status + body on non-2xx).

- [ ] **Step 1: Write `lib/discord.mjs`**

Port of `buildEmbed` + `postToDiscord` from current `digest.mjs` (lines 168–260). Changes: reads the neutral digest (formats PR/issue/other lines from structured objects, applying the 60-char title slice here), commit dedupe is gone (source already dedupes), and `post` throws instead of calling `process.exit` (the orchestrator owns exit codes).

```js
// lib/discord.mjs — Discord destination: builds a webhook embed payload and posts it.

export function buildPayload(digest) {
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });

  const fields = [];

  // Commits per repo
  for (const [repo, commits] of Object.entries(digest.pushes)) {
    let value = "";
    for (const { sha, message } of commits) {
      const line = `> \`${sha}\` ${message}\n`;
      if (value.length + line.length > 1000) {
        const shown = value.split("\n").filter(Boolean).length;
        value += `> _...and ${commits.length - shown} more_\n`;
        break;
      }
      value += line;
    }
    fields.push({
      name: `🟢 \`${repo}\` — ${commits.length} commit${commits.length === 1 ? "" : "s"}`,
      value: value.trim(),
      inline: false,
    });
  }

  if (digest.prs.length > 0) {
    fields.push({
      name: "🟣 Pull requests",
      value: digest.prs
        .map((p) => `\`${p.repo}\` — ${p.action} PR #${p.number}: ${p.title.slice(0, 60)}`)
        .join("\n"),
      inline: false,
    });
  }

  if (digest.issues.length > 0) {
    fields.push({
      name: "🟡 Issues",
      value: digest.issues
        .map((i) => `\`${i.repo}\` — ${i.action} #${i.number}: ${i.title.slice(0, 60)}`)
        .join("\n"),
      inline: false,
    });
  }

  if (digest.other.length > 0) {
    fields.push({
      name: "📦 Other",
      value: digest.other.map((o) => `\`${o.repo}\` — ${o.description}`).join("\n"),
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title: `${digest.username} — ${today}`,
        description: `${digest.eventCount} event${digest.eventCount === 1 ? "" : "s"} across ${digest.repoCount} repo${digest.repoCount === 1 ? "" : "s"}`,
        color: 0x5865f2,
        fields,
        footer: { text: "via GitHub API" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function post(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook error: ${res.status} — ${text}`);
  }
}
```

- [ ] **Step 2: Verify `buildPayload` against a fixture digest**

Run:

```bash
node -e '
import("./lib/discord.mjs").then(({ buildPayload }) => {
  const digest = {
    username: "TekGadgt",
    eventCount: 3,
    repoCount: 2,
    pushes: { "repo-a": [{ sha: "abc1234", message: "fix the thing" }] },
    prs: [{ repo: "repo-b", action: "opened", number: 7, title: "Add feature" }],
    issues: [],
    other: [{ repo: "repo-a", description: "created branch feature-x" }],
  };
  const p = buildPayload(digest);
  const e = p.embeds[0];
  console.assert(e.title.startsWith("TekGadgt — "), "title");
  console.assert(e.description === "3 events across 2 repos", "description");
  console.assert(e.fields.length === 3, "field count");
  console.assert(e.fields[0].name === "🟢 \`repo-a\` — 1 commit", "commit field name");
  console.assert(e.fields[0].value === "> \`abc1234\` fix the thing", "commit field value");
  console.assert(e.fields[1].value === "\`repo-b\` — opened PR #7: Add feature", "pr line");
  console.assert(e.fields[2].value === "\`repo-a\` — created branch feature-x", "other line");
  console.log("discord buildPayload OK");
});
'
```

Expected: `discord buildPayload OK` and no assertion failures printed.

- [ ] **Step 3: Commit**

```bash
git add lib/discord.mjs
git commit -m "feat: extract Discord destination module"
```

---

### Task 3: Rewrite `digest.mjs` as the orchestrator

**Files:**
- Modify: `digest.mjs` (full rewrite — replaces all 279 lines)

**Interfaces:**
- Consumes: `fetchActivity({ username, token, since })` from `lib/github.mjs`; `buildPayload(digest)` / `post(url, payload)` from `lib/discord.mjs`.
- Produces: the CLI contract — exit 0 on success or no-activity skip, exit 1 on validation error, auth error, or any destination failure. Reads `GITHUB_USERNAME`, `GITHUB_TOKEN`, `DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `LOOKBACK_DAYS`. The `destinations` array is where the Slack plan later registers `lib/slack.mjs`.

- [ ] **Step 1: Replace the contents of `digest.mjs`**

```js
// digest.mjs — orchestrator: reads config, fetches activity from the source,
// fans out to each configured destination. Sources/destinations live in lib/.

import { fetchActivity } from "./lib/github.mjs";
import * as discord from "./lib/discord.mjs";
import * as slack from "./lib/slack.mjs";

// Empty-string env values are treated as unset
const env = (name) => process.env[name] || undefined;

const config = {
  username: env("GITHUB_USERNAME"),
  token: env("GITHUB_TOKEN"),
  discordWebhookUrl: env("DISCORD_WEBHOOK_URL"),
  slackWebhookUrl: env("SLACK_WEBHOOK_URL"),
  lookbackDays: parseInt(env("LOOKBACK_DAYS") || "1", 10),
};

const missing = [];
if (!config.username) missing.push("GITHUB_USERNAME");
if (!config.discordWebhookUrl && !config.slackWebhookUrl) {
  missing.push("DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL");
}
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const destinations = [];
if (config.discordWebhookUrl) {
  destinations.push({ name: "Discord", url: config.discordWebhookUrl, module: discord });
}
if (config.slackWebhookUrl) {
  destinations.push({ name: "Slack", url: config.slackWebhookUrl, module: slack });
}

async function main() {
  const since = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000);
  const digest = await fetchActivity({
    username: config.username,
    token: config.token,
    since,
  });

  if (digest.eventCount === 0) {
    console.log(`No activity in the last ${config.lookbackDays} day(s). Skipping post.`);
    return;
  }

  let anyFailed = false;
  for (const dest of destinations) {
    try {
      const payload = dest.module.buildPayload(digest);
      await dest.module.post(dest.url, payload);
      console.log(`Digest posted to ${dest.name}.`);
    } catch (err) {
      console.error(`${dest.name} delivery failed: ${err.message}`);
      anyFailed = true;
    }
  }
  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
```

**Note:** this imports `./lib/slack.mjs`, which does not exist until the Slack plan runs. If executing this plan standalone (without the Slack plan immediately after), create a placeholder `lib/slack.mjs`:

```js
// lib/slack.mjs — Slack destination (see docs/superpowers/specs/2026-07-11-slack-support-design.md)
export function buildPayload() {
  throw new Error("Slack destination not implemented yet");
}
export async function post() {
  throw new Error("Slack destination not implemented yet");
}
```

- [ ] **Step 2: Verify the validation error path**

Run:

```bash
env -u GITHUB_USERNAME -u DISCORD_WEBHOOK_URL -u SLACK_WEBHOOK_URL node digest.mjs; echo "exit: $status"
```

(`$status` is fish syntax; in bash/zsh use `echo "exit: $?"`.)

Expected output:

```
Missing required environment variables: GITHUB_USERNAME, DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL
exit: 1
```

Also verify empty string counts as unset:

```bash
GITHUB_USERNAME=TekGadgt DISCORD_WEBHOOK_URL="" node digest.mjs; echo "exit: $status"
```

Expected: `Missing required environment variables: DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL`, exit 1.

- [ ] **Step 3: Verify the invalid-token error path**

Run:

```bash
GITHUB_USERNAME=TekGadgt GITHUB_TOKEN=ghp_invalid DISCORD_WEBHOOK_URL=https://example.invalid node digest.mjs; echo "exit: $status"
```

Expected: `GitHub auth failed (401): token invalid or expired`, exit 1, and no attempt to post.

- [ ] **Step 4: Verify a full no-token run end-to-end (destination failure path)**

Run (example.com returns non-2xx for POST, so this also proves per-destination error handling without a real webhook):

```bash
GITHUB_USERNAME=TekGadgt LOOKBACK_DAYS=7 DISCORD_WEBHOOK_URL=https://example.com/nope node digest.mjs; echo "exit: $status"
```

Expected: `Discord delivery failed: Discord webhook error: <status> — ...`, exit 1. (If the account had zero public activity in 7 days, expect the skip message and exit 0 instead — then raise `LOOKBACK_DAYS` until events appear.)

- [ ] **Step 5: Commit**

```bash
git add digest.mjs lib/slack.mjs
git commit -m "feat: orchestrator with multi-destination fan-out and PAT support"
```

---

### Task 4: Workflow and README updates

**Files:**
- Modify: `.github/workflows/daily-digest.yml` (env block, lines 24–27)
- Modify: `README.md`

**Interfaces:**
- Consumes: the env contract from Task 3 (`GITHUB_TOKEN`, secret name `GH_PAT`).
- Produces: nothing code-facing.

- [ ] **Step 1: Add `GITHUB_TOKEN` to the workflow env block**

In `.github/workflows/daily-digest.yml`, change the `env:` block of the "Post digest to Discord" step to:

```yaml
        env:
          GITHUB_USERNAME: TekGadgt
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}        # optional — private repo support
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          LOOKBACK_DAYS: ${{ github.event.inputs.lookback_days || '1' }}
```

(An unset `GH_PAT` secret yields an empty string, which the script treats as "no token".)

- [ ] **Step 2: Update `README.md`**

Make these changes:

1. In Setup step 2, change the copy instruction to: `Copy .github/workflows/daily-digest.yml, digest.mjs, and the lib/ directory into your repo`.
2. Add a new setup section after the secrets step:

```markdown
### Private repo support (optional)

To include private repo activity, create a **classic** Personal Access Token with the
`repo` scope at [github.com/settings/tokens](https://github.com/settings/tokens) and add
it as a repo secret named `GH_PAT`. Classic is recommended — fine-grained tokens have
patchy Events API support. Note the token's expiration date; you'll need to rotate it
occasionally.

> **Privacy note:** with a token configured, private repo names and commit messages are
> posted to your chat channels — make sure those channels are appropriately private.
```

3. In the Config table, add a row:

```markdown
| `GITHUB_TOKEN` | repo secret `GH_PAT` (optional) | — (public activity only) |
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/daily-digest.yml README.md
git commit -m "docs: PAT setup instructions and workflow token wiring"
```

---

### Task 5: End-to-end verification (spec's manual checklist)

Requires real secrets; items that need them are marked. Run what's possible locally, and hand the rest to the user as a checklist.

- [ ] **Step 1: No-token baseline** *(needs a real/throwaway Discord webhook URL)*

```bash
GITHUB_USERNAME=TekGadgt LOOKBACK_DAYS=7 DISCORD_WEBHOOK_URL=<throwaway> node digest.mjs
```

Expected: digest posts, content matches pre-restructure output (public activity only), exit 0.

- [ ] **Step 2: With a valid PAT** *(needs the user's PAT)*

Same command plus `GITHUB_TOKEN=<pat>`. Expected: digest now includes private repo activity.

- [ ] **Step 3: Invalid token** — already covered by Task 3 Step 3.

- [ ] **Step 4: No webhook configured** — already covered by Task 3 Step 2.
