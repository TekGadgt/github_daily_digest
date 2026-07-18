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
