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
