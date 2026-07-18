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
