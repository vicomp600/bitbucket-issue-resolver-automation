export async function run({ mondayItemId, mondayUrl, repos, channelId, userId }) {
  const gqlResponse = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: process.env.MONDAY_API_TOKEN,
      "Content-Type": "application/json",
      "API-Version": "2024-01",
    },
    body: JSON.stringify({
      query: `query {
        items(ids: [${mondayItemId}]) {
          name
          updates(limit: 20) {
            text_body
            created_at
            creator { name }
          }
          column_values {
            type
            text
          }
        }
      }`,
    }),
  });

  const gqlData = await gqlResponse.json();
  const item = gqlData?.data?.items?.[0];
  if (!item) throw new Error(`Monday item ${mondayItemId} not found`);

  const itemName = item.name;

  const columnText =
    item.column_values
      ?.filter((column) => column.text)
      .map((column) => `${column.type}: ${column.text}`)
      .join("\n") ?? "";

  const parts = [
    `# ${itemName}`,
    columnText ? `\n## Fields\n${columnText}` : "",
    item.updates?.length
      ? `\n## Updates\n` +
        [...item.updates]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((update) => `[${update.creator?.name} @ ${update.created_at}]: ${update.text_body}`)
          .join("\n\n")
      : "",
  ].join("");

  const mondayContext = parts.slice(0, 8000);

  const slackResponse = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: channelId,
      text: `Hey <@${userId}>, 🔍 Analyzing *<${mondayUrl}|${itemName}>* across repos: ${repos.join(", ")}...`,
    }),
  });

  const slackData = await slackResponse.json();
  if (!slackData.ok) throw new Error(`chat.postMessage failed: ${slackData.error}`);

  return { itemName, mondayContext, thread_ts: slackData.ts };
}
