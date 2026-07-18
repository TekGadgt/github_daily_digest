# Slack Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Slack as a second, optional digest destination via a Slack incoming webhook.

**Architecture:** New `lib/slack.mjs` implements the same destination interface as `lib/discord.mjs` (`buildPayload(digest)` + `post(url, payload)`), rendering Block Kit blocks that mirror the Discord embed. The orchestrator from the PAT/restructure plan already registers Slack when `SLACK_WEBHOOK_URL` is set — no orchestrator changes needed beyond replacing the placeholder module. Spec: `docs/superpowers/specs/2026-07-11-slack-support-design.md`.

**Tech Stack:** Node.js 24, ES modules, built-in `fetch`. Zero new dependencies. Slack incoming webhook (plain HTTPS POST — no bot, no local process).

**Depends on:** `2026-07-18-github-pat-auth-restructure.md` completed (neutral digest shape, orchestrator fan-out, placeholder `lib/slack.mjs`).

## Global Constraints

- Escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` in **all user-derived text** (commit messages, PR/issue titles, repo names, `other` descriptions). Discord needs no escaping — this lives only here.
- Slack limits: 3,000 chars per section text; 50 blocks per message (header + context leave room for 48 sections); 150-char header limit (username + date fits — no handling needed).
- Date pinned to `America/New_York`, same as the Discord title.
- `post()` throws on non-2xx with status + body text.

---

### Task 1: `lib/slack.mjs` — the Slack destination module

**Files:**
- Modify: `lib/slack.mjs` (replace the placeholder written in the restructure plan, Task 3)

**Interfaces:**
- Consumes: the `Digest` shape — `{ username, eventCount, repoCount, pushes: { [repo]: [{ sha, message }] }, prs: [{ repo, action, number, title }], issues: [...same], other: [{ repo, description }] }`.
- Produces: `buildPayload(digest) → { blocks: [...] }` and `post(webhookUrl, payload) → Promise<void>`.

- [ ] **Step 1: Replace the contents of `lib/slack.mjs`**

```js
// lib/slack.mjs — Slack destination: builds a Block Kit payload and posts it
// to an incoming webhook.

// Slack mrkdwn treats &, <, > as control characters — escape all user-derived text.
function esc(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const SECTION_TEXT_LIMIT = 3000;
const MAX_BLOCKS = 50;

function section(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function commitSection(repo, commits) {
  const header = `*🟢 \`${esc(repo)}\` — ${commits.length} commit${commits.length === 1 ? "" : "s"}*\n`;
  // Leave headroom for the "...and N more" trailer line within the 3,000 limit
  const budget = SECTION_TEXT_LIMIT - 100;
  let text = header;
  let shown = 0;
  for (const { sha, message } of commits) {
    const line = `> \`${esc(sha)}\` ${esc(message)}\n`;
    if (text.length + line.length > budget) {
      text += `> _...and ${commits.length - shown} more_\n`;
      break;
    }
    text += line;
    shown++;
  }
  return section(text.trimEnd());
}

function listSection(title, lines) {
  let text = `*${title}*\n`;
  const budget = SECTION_TEXT_LIMIT - 100;
  let shown = 0;
  for (const line of lines) {
    if (text.length + line.length + 1 > budget) {
      text += `_...and ${lines.length - shown} more_\n`;
      break;
    }
    text += `${line}\n`;
    shown++;
  }
  return section(text.trimEnd());
}

export function buildPayload(digest) {
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${digest.username} — ${today}` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${digest.eventCount} event${digest.eventCount === 1 ? "" : "s"} across ${digest.repoCount} repo${digest.repoCount === 1 ? "" : "s"}`,
        },
      ],
    },
  ];

  // Sections for the PR/issue/other lists (built first so the repo-section
  // budget below can account for them within the 50-block limit)
  const listBlocks = [];
  if (digest.prs.length > 0) {
    listBlocks.push(
      listSection(
        "🟣 Pull requests",
        digest.prs.map(
          (p) => `\`${esc(p.repo)}\` — ${esc(p.action)} PR #${p.number}: ${esc(p.title.slice(0, 60))}`
        )
      )
    );
  }
  if (digest.issues.length > 0) {
    listBlocks.push(
      listSection(
        "🟡 Issues",
        digest.issues.map(
          (i) => `\`${esc(i.repo)}\` — ${esc(i.action)} #${i.number}: ${esc(i.title.slice(0, 60))}`
        )
      )
    );
  }
  if (digest.other.length > 0) {
    listBlocks.push(
      listSection(
        "📦 Other",
        digest.other.map((o) => `\`${esc(o.repo)}\` — ${esc(o.description)}`)
      )
    );
  }

  // One section per repo with commits, collapsing the tail if we'd blow the
  // 50-block limit (header + context + repo sections + list sections)
  const repoEntries = Object.entries(digest.pushes);
  const repoBudget = MAX_BLOCKS - blocks.length - listBlocks.length;
  if (repoEntries.length <= repoBudget) {
    for (const [repo, commits] of repoEntries) {
      blocks.push(commitSection(repo, commits));
    }
  } else {
    const kept = repoEntries.slice(0, repoBudget - 1);
    for (const [repo, commits] of kept) {
      blocks.push(commitSection(repo, commits));
    }
    blocks.push(
      section(`_...and ${repoEntries.length - kept.length} more repos with activity_`)
    );
  }

  blocks.push(...listBlocks);
  return { blocks };
}

export async function post(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack webhook error: ${res.status} — ${text}`);
  }
}
```

- [ ] **Step 2: Verify `buildPayload` against fixtures (shape, escaping, block cap)**

Run:

```bash
node -e '
import("./lib/slack.mjs").then(({ buildPayload }) => {
  // Basic shape + escaping
  const digest = {
    username: "TekGadgt",
    eventCount: 2,
    repoCount: 1,
    pushes: { "repo-a": [{ sha: "abc1234", message: "use <T> & fix >= bug" }] },
    prs: [{ repo: "repo-a", action: "opened", number: 7, title: "Support <html> & more" }],
    issues: [],
    other: [],
  };
  const p = buildPayload(digest);
  console.assert(p.blocks[0].type === "header", "header block");
  console.assert(p.blocks[1].type === "context", "context block");
  console.assert(p.blocks[1].elements[0].text === "2 events across 1 repo", "context text");
  const commitText = p.blocks[2].text.text;
  console.assert(commitText.includes("use &lt;T&gt; &amp; fix &gt;= bug"), "commit escaping: " + commitText);
  const prText = p.blocks[3].text.text;
  console.assert(prText.includes("Support &lt;html&gt; &amp; more"), "pr escaping: " + prText);

  // Block cap: 60 repos + one PR list must collapse to exactly 50 blocks
  const manyPushes = {};
  for (let n = 0; n < 60; n++) manyPushes["repo-" + n] = [{ sha: "a".repeat(7), message: "m" }];
  const big = buildPayload({ ...digest, pushes: manyPushes });
  console.assert(big.blocks.length === 50, "block cap, got " + big.blocks.length);
  const collapse = big.blocks[48].text.text; // last repo slot, before the PR section
  console.assert(/more repos with activity/.test(collapse), "collapse line: " + collapse);
  console.assert(big.blocks[49].text.text.includes("Pull requests"), "list section last");

  console.log("slack buildPayload OK");
});
'
```

Expected: `slack buildPayload OK`, no assertion failures.

- [ ] **Step 3: Commit**

```bash
git add lib/slack.mjs
git commit -m "feat: Slack destination via incoming webhook (Block Kit)"
```

---

### Task 2: Workflow and README updates

**Files:**
- Modify: `.github/workflows/daily-digest.yml` (env block)
- Modify: `README.md`

- [ ] **Step 1: Add `SLACK_WEBHOOK_URL` to the workflow env block**

```yaml
        env:
          GITHUB_USERNAME: TekGadgt
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}        # optional — private repo support
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
          LOOKBACK_DAYS: ${{ github.event.inputs.lookback_days || '1' }}
```

Also rename the step from "Post digest to Discord" to "Post digest".

- [ ] **Step 2: Update `README.md`**

1. Reword the intro/setup to say the digest posts to **Discord, Slack, or both** — at least one webhook is required.
2. Add Slack setup steps alongside the Discord ones:

```markdown
**Slack (optional):** create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) →
enable **Incoming Webhooks** → **Add New Webhook to Workspace** and pick the target
channel → copy the webhook URL into a repo secret named `SLACK_WEBHOOK_URL`.
```

3. Add a Config table row:

```markdown
| `SLACK_WEBHOOK_URL` | repo secret (optional) | — |
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/daily-digest.yml README.md
git commit -m "docs: Slack webhook setup and workflow wiring"
```

---

### Task 3: End-to-end verification (spec's manual checklist)

Items needing a real Slack webhook are for the user to run.

- [ ] **Step 1: Slack-only run** *(needs a throwaway Slack webhook)*

```bash
GITHUB_USERNAME=TekGadgt LOOKBACK_DAYS=7 SLACK_WEBHOOK_URL=<throwaway> node digest.mjs
```

Expected: digest in Slack with header, context counts, per-repo commit sections; exit 0.

- [ ] **Step 2: Both webhooks** — both channels receive the digest.

- [ ] **Step 3: Escaping check** — a commit message containing `<`, `>`, `&` renders literally in Slack (covered structurally by Task 1 Step 2; visual confirmation needs a real post).

- [ ] **Step 4: Partial failure** — invalid `SLACK_WEBHOOK_URL` + valid Discord URL → Discord posts, run logs `Slack delivery failed: ...`, exit 1. Locally reproducible without secrets:

```bash
GITHUB_USERNAME=TekGadgt LOOKBACK_DAYS=7 DISCORD_WEBHOOK_URL=https://example.com/nope SLACK_WEBHOOK_URL=https://example.com/nope node digest.mjs; echo "exit: $status"
```

Expected: both `... delivery failed:` lines, exit 1 — proving one failure doesn't stop the other destination.

- [ ] **Step 5: Neither webhook set** — covered by restructure plan Task 3 Step 2.
