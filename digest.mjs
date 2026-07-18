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
