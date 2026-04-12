// digest.mjs — Fetches last 24h of GitHub activity and posts to Discord

const USERNAME = process.env.GITHUB_USERNAME;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!USERNAME || !WEBHOOK_URL) {
  console.error("Missing GITHUB_USERNAME or DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

// Event types worth reporting — skip stars, forks, watches
const TRACKED_TYPES = new Set([
  "PushEvent",
  "PullRequestEvent",
  "IssuesEvent",
  "CreateEvent",
  "DeleteEvent",
  "ReleaseEvent",
  "IssueCommentEvent",
  "PullRequestReviewEvent",
]);

async function fetchEvents() {
  const events = [];
  // GitHub Events API returns max 10 pages of 30
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/users/${USERNAME}/events?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "github-discord-digest",
        },
      }
    );
    if (!res.ok) {
      console.error(`GitHub API error: ${res.status}`);
      break;
    }
    const page_events = await res.json();
    if (page_events.length === 0) break;

    for (const event of page_events) {
      if (new Date(event.created_at) < SINCE) return events;
      if (TRACKED_TYPES.has(event.type)) events.push(event);
    }
  }
  return events;
}

function formatEvents(events) {
  const pushes = {};   // repo -> commits[]
  const prs = [];
  const issues = [];
  const other = [];

  for (const e of events) {
    const repo = e.repo.name.replace(`${USERNAME}/`, "");

    switch (e.type) {
      case "PushEvent": {
        const commits = e.payload.commits || [];
        if (commits.length === 0) break;
        if (!pushes[repo]) pushes[repo] = [];
        for (const c of commits) {
          const msg = c.message.split("\n")[0].slice(0, 72);
          pushes[repo].push(msg);
        }
        break;
      }
      case "PullRequestEvent": {
        const pr = e.payload.pull_request;
        prs.push(
          `\`${repo}\` — ${e.payload.action} PR #${pr.number}: ${pr.title.slice(0, 60)}`
        );
        break;
      }
      case "IssuesEvent": {
        const issue = e.payload.issue;
        issues.push(
          `\`${repo}\` — ${e.payload.action} #${issue.number}: ${issue.title.slice(0, 60)}`
        );
        break;
      }
      case "CreateEvent": {
        if (e.payload.ref_type === "repository") {
          other.push(`Created new repo \`${repo}\``);
        } else {
          other.push(
            `\`${repo}\` — created ${e.payload.ref_type} \`${e.payload.ref}\``
          );
        }
        break;
      }
      case "ReleaseEvent": {
        const rel = e.payload.release;
        other.push(`\`${repo}\` — released ${rel.tag_name}: ${rel.name || ""}`);
        break;
      }
      default:
        break;
    }
  }

  return { pushes, prs, issues, other };
}

function buildEmbed(events, formatted) {
  const repos = new Set(events.map((e) => e.repo.name));
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const fields = [];

  // Pushes section
  const pushEntries = Object.entries(formatted.pushes);
  if (pushEntries.length > 0) {
    let value = "";
    for (const [repo, commits] of pushEntries) {
      const unique = [...new Set(commits)];
      value += `\`${repo}\` — ${unique.length} commit${unique.length === 1 ? "" : "s"}\n`;
      for (const msg of unique.slice(0, 5)) {
        value += `> • ${msg}\n`;
      }
      if (unique.length > 5) {
        value += `> _...and ${unique.length - 5} more_\n`;
      }
    }
    fields.push({ name: "🟢 Pushes", value: value.trim(), inline: false });
  }

  // PRs
  if (formatted.prs.length > 0) {
    fields.push({
      name: "🟣 Pull requests",
      value: formatted.prs.join("\n"),
      inline: false,
    });
  }

  // Issues
  if (formatted.issues.length > 0) {
    fields.push({
      name: "🟡 Issues",
      value: formatted.issues.join("\n"),
      inline: false,
    });
  }

  // Other
  if (formatted.other.length > 0) {
    fields.push({
      name: "📦 Other",
      value: formatted.other.join("\n"),
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title: `${USERNAME} — ${today}`,
        description: `${events.length} event${events.length === 1 ? "" : "s"} across ${repos.size} repo${repos.size === 1 ? "" : "s"}`,
        color: 0x5865f2,
        fields,
        footer: {
          text: "via GitHub Events API",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function postToDiscord(payload) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Discord webhook error: ${res.status} — ${text}`);
    process.exit(1);
  }
  console.log("Digest posted to Discord.");
}

async function main() {
  const events = await fetchEvents();

  if (events.length === 0) {
    console.log("No activity in the last 24h. Skipping post.");
    return;
  }

  const formatted = formatEvents(events);
  const payload = buildEmbed(events, formatted);
  await postToDiscord(payload);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
