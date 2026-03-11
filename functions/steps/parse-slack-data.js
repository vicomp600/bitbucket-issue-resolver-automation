export async function run(rawPayload) {
  const payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;

  if (payload.type !== "view_submission") return null;
  if (payload.view.callback_id !== "fix_issue_modal") return null;

  const values = payload.view.state.values;
  const mondayUrl = values.monday_url.value.value;
  const selectedRepos = values.repo_select.value.selected_options.map(
    (option) => option.value
  );
  const otherRepos = (values.repo_other.value.value ?? "")
    .split(" ")
    .filter(Boolean);
  const repos = [...selectedRepos, ...otherRepos];
  const branch = values.branch.value.value || "staging";
  const userContext = values.context.value.value ?? "";
  const { channelId, userId } = JSON.parse(payload.view.private_metadata);

  const itemIdMatch = mondayUrl.match(/\/pulses\/(\d+)/);
  if (!itemIdMatch) {
    await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channelId,
        user: userId,
        text: "Invalid Monday URL. Expected format: `https://taglitbri.monday.com/boards/.../pulses/...`",
      }),
    });
    return null;
  }
  const mondayItemId = itemIdMatch[1];

  return { mondayItemId, mondayUrl, repos, branch, userContext, channelId, userId };
}
