export async function run({ writeFix, itemName, mondayUrl, thread_ts, channelId, userId, repos, branch, mondayItemId }) {
  const issueLink = `<${mondayUrl}|${itemName}>`;

  let message;
  if (writeFix.decision === "fix") {
    const fileList = (writeFix.files_to_modify ?? [])
      .map((file) => `• \`${file.repo_slug}/${file.path}\``)
      .join("\n");

    message = [
      `🤖 *Analysis complete* — I found the issue and have a fix ready.`,
      `*Issue:* ${issueLink}`,
      `*Confidence:* ${writeFix.confidence}/100`,
      ``,
      `*Root cause:*\n${writeFix.analysis}`,
      ``,
      `*What I'm about to change:*\n${writeFix.fix_description}`,
      ``,
      `*Files to modify:*\n${fileList}`,
      ``,
      `_Applying fix now..._`,
    ].join("\n");
  } else {
    const suggestedApproach = writeFix.suggested_approach
      ? `\n\n*Suggested approach:*\n${writeFix.suggested_approach}`
      : "";

    message = [
      `🔍 *Analysis complete* — This issue needs manual review.`,
      `*Issue:* ${issueLink}`,
      `*Confidence:* ${writeFix.confidence}/100`,
      ``,
      `*Root cause:*\n${writeFix.analysis}`,
      suggestedApproach,
    ]
      .filter(Boolean)
      .join("\n");
  }

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, thread_ts, text: message }),
  });

  return { writeFix, itemName, mondayUrl, thread_ts, channelId, userId, repos, branch, mondayItemId };
}
