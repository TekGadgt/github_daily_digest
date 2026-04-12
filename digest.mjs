// digest.mjs — Fetches GitHub activity and posts to Discord
// Strategy: Events API for the index (active repos, PRs, issues, releases)
//           Commits API for actual commit data per repo

const USERNAME = process.env.GITHUB_USERNAME;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!USERNAME || !WEBHOOK_URL) {
  console.error("Missing GITHUB_USERNAME or DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || "1", 10);
const SINCE = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

const GITHUB_HEADERS = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "github-discord-digest",
};

// --- Step 1: Events API for the activity index ---

const TRACKED_TYPES = new Set([
  "PushEvent",
  "PullRequestEvent",
  "IssuesEvent",
  "CreateEvent",
  "DeleteEvent",
  "ReleaseEvent",
]);

async function fetchEvents() {
  const events = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(
      `https://api.github.com/users/${USERNAME}/events?per_page=100&page=${page}`,
      { headers: GITHUB_HEADERS }
    );
    if (!res.ok) {
      console.error(`GitHub Events API error: ${res.status}`);
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

// --- Step 2: Commits API for real commit data ---

async function fetchCommits(repoFullName) {
  const commits = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const url = `https://api.github.com/repos/${repoFullName}/commits?author=${USERNAME}&since=${SINCE.toISOString()}&per_page=100&page=${page}`;
      const res = await fetch(url, { headers: GITHUB_HEADERS });
      if (!res.ok) {
        console.warn(`Commits API error for ${repoFullName}: ${res.status}`);
        break;
      }
      const page_commits = await res.json();
      if (page_commits.length === 0) break;

      for (const c of page_commits) {
        const msg = (c.commit?.message || "").split("\n")[0].slice(0, 72);
        const sha = c.sha?.slice(0, 7) || "";
        commits.push({ msg, sha });
      }
    }
  } catch (err) {
    console.warn(`Failed to fetch commits for ${repoFullName}: ${err.message}`);
  }
  return commits;
}

// --- Step 3: Process events + enrich with commits ---

async function fetchTitle(repoFullName, type, number) {
  try {
    const endpoint = type === "pr" ? "pulls" : "issues";
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/${endpoint}/${number}`,
      { headers: GITHUB_HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

async function buildDigest(events) {
  const pushRepos = new Set();
  const prs = [];
  const issues = [];
  const other = [];

  for (const e of events) {
    const repoShort = e.repo.name.replace(`${USERNAME}/`, "");

    try {
      switch (e.type) {
        case "PushEvent":
          pushRepos.add(e.repo.name);
          break;

        case "PullRequestEvent": {
          const pr = e.payload?.pull_request;
          if (!pr) break;
          let title = pr.title;
          if (!title) title = await fetchTitle(e.repo.name, "pr", pr.number);
          prs.push(
            `\`${repoShort}\` — ${e.payload.action} PR #${pr.number}: ${(title || "untitled").slice(0, 60)}`
          );
          break;
        }
        case "IssuesEvent": {
          const issue = e.payload?.issue;
          if (!issue) break;
          let title = issue.title;
          if (!title) title = await fetchTitle(e.repo.name, "issue", issue.number);
          issues.push(
            `\`${repoShort}\` — ${e.payload.action} #${issue.number}: ${(title || "untitled").slice(0, 60)}`
          );
          break;
        }
        case "CreateEvent": {
          if (e.payload.ref_type === "repository") {
            other.push(`Created new repo \`${repoShort}\``);
          } else {
            other.push(
              `\`${repoShort}\` — created ${e.payload.ref_type} \`${e.payload.ref}\``
            );
          }
          break;
        }
        case "ReleaseEvent": {
          const rel = e.payload?.release;
          if (!rel) break;
          other.push(`\`${repoShort}\` — released ${rel.tag_name}: ${rel.name || ""}`);
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
    const repoShort = repoFullName.replace(`${USERNAME}/`, "");
    const commits = await fetchCommits(repoFullName);
    if (commits.length > 0) {
      pushes[repoShort] = commits;
    }
  }

  return { pushes, prs, issues, other };
}

// --- Step 4: Build Discord embed ---

function buildEmbed(events, digest) {
  const repos = new Set(events.map((e) => e.repo.name));
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const fields = [];

  // Commits per repo
  for (const [repo, commits] of Object.entries(digest.pushes)) {
    // Dedupe by sha
    const seen = new Set();
    const unique = commits.filter((c) => {
      if (seen.has(c.sha)) return false;
      seen.add(c.sha);
      return true;
    });

    let value = "";
    for (const { msg, sha } of unique) {
      const line = `> \`${sha}\` ${msg}\n`;
      if (value.length + line.length > 1000) {
        const shown = value.split("\n").filter(Boolean).length;
        value += `> _...and ${unique.length - shown} more_\n`;
        break;
      }
      value += line;
    }
    fields.push({
      name: `🟢 \`${repo}\` — ${unique.length} commit${unique.length === 1 ? "" : "s"}`,
      value: value.trim(),
      inline: false,
    });
  }

  if (digest.prs.length > 0) {
    fields.push({
      name: "🟣 Pull requests",
      value: digest.prs.join("\n"),
      inline: false,
    });
  }

  if (digest.issues.length > 0) {
    fields.push({
      name: "🟡 Issues",
      value: digest.issues.join("\n"),
      inline: false,
    });
  }

  if (digest.other.length > 0) {
    fields.push({
      name: "📦 Other",
      value: digest.other.join("\n"),
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
        footer: { text: "via GitHub API" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// --- Step 5: Post to Discord ---

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
    console.log(`No activity in the last ${LOOKBACK_DAYS} day(s). Skipping post.`);
    return;
  }

  const digest = await buildDigest(events);
  const payload = buildEmbed(events, digest);
  await postToDiscord(payload);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
