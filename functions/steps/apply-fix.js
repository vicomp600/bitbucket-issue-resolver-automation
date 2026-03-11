export async function run({
  writeFix,
  itemName,
  mondayUrl,
  thread_ts,
  channelId,
  branch: targetBranch,
  mondayItemId,
}) {
  if (writeFix.decision !== "fix") {
    return { skipped: true, reason: "decision was analyze" };
  }

  const workspace = process.env.BITBUCKET_WORKSPACE;
  const bitbucketAuth = Buffer.from(
    `${process.env.BITBUCKET_USERNAME}:${process.env.BITBUCKET_API_KEY}`
  ).toString("base64");

  async function bitbucketRequest(path, options = {}) {
    const response = await fetch(`https://api.bitbucket.org/2.0${path}`, {
      headers: { Authorization: `Basic ${bitbucketAuth}`, ...options.headers },
      ...options,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Bitbucket ${response.status} ${path}: ${body}`);
    }
    return response;
  }

  async function getLatestCommitHash(repoSlug, branchName) {
    const response = await bitbucketRequest(
      `/repositories/${workspace}/${repoSlug}/refs/branches/${branchName}`
    );
    const data = await response.json();
    return data.target.hash;
  }

  async function getBranchHeadHash(repoSlug, branchName) {
    try {
      return await getLatestCommitHash(repoSlug, branchName);
    } catch {
      return null; // branch doesn't exist yet
    }
  }

  async function commitFilesToNewBranch(
    repoSlug,
    newBranchName,
    commitMessage,
    filesToCommit,
    sourceCommitHash
  ) {
    const formData = new FormData();
    formData.append("branch", newBranchName);
    formData.append("message", commitMessage);
    formData.append("parents", sourceCommitHash);
    for (const fileChange of filesToCommit) {
      formData.append(fileChange.path, fileChange.new_content);
    }
    await bitbucketRequest(`/repositories/${workspace}/${repoSlug}/src`, {
      method: "POST",
      body: formData,
    });
  }

  async function findExistingPullRequest(repoSlug, prBranch) {
    const response = await bitbucketRequest(
      `/repositories/${workspace}/${repoSlug}/pullrequests?q=source.branch.name="${prBranch}" AND state="OPEN"`
    );
    const data = await response.json();
    return data.values?.[0] ?? null;
  }

  async function createPullRequest(repoSlug, prBranch, title, description) {
    const existing = await findExistingPullRequest(repoSlug, prBranch);
    if (existing) {
      console.log(`PR already exists for ${prBranch}: ${existing.links.html.href}`);
      return existing;
    }
    const response = await bitbucketRequest(
      `/repositories/${workspace}/${repoSlug}/pullrequests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          source: { branch: { name: prBranch } },
          destination: { branch: { name: targetBranch } },
          close_source_branch: true,
        }),
      }
    );
    return response.json();
  }

  // Group file changes by repo
  const filesByRepo = {};
  for (const fileChange of writeFix.files_to_modify) {
    if (!filesByRepo[fileChange.repo_slug])
      filesByRepo[fileChange.repo_slug] = [];
    filesByRepo[fileChange.repo_slug].push(fileChange);
  }

  const issueSlug = itemName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  const prBranchName = `fix/monday-${mondayItemId}-${issueSlug}`;
  const commitMessage = `fix: ${writeFix.fix_description}\n\nMonday issue: ${mondayUrl}`;
  const pullRequestUrls = [];

  for (const [repoSlug, filesToCommit] of Object.entries(filesByRepo)) {
    const sourceCommitHash =
      (await getBranchHeadHash(repoSlug, prBranchName)) ??
      (await getLatestCommitHash(repoSlug, targetBranch));
    await commitFilesToNewBranch(
      repoSlug,
      prBranchName,
      commitMessage,
      filesToCommit,
      sourceCommitHash
    );

    const pullRequest = await createPullRequest(
      repoSlug,
      prBranchName,
      `[${mondayItemId}] ${itemName}`,
      [
        writeFix.fix_description,
        "",
        `**Root cause analysis:**`,
        writeFix.analysis,
        "",
        `**Monday issue:** ${mondayUrl}`,
      ].join("\n")
    );

    pullRequestUrls.push(pullRequest.links.html.href);
    console.log(`PR created: ${pullRequest.links.html.href}`);
  }

  const prLinks = pullRequestUrls
    .map((url) => `• <${url}|View pull request>`)
    .join("\n");
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: channelId,
      thread_ts,
      text: `✅ Fix applied! Pull request is ready for review:\n${prLinks}`,
    }),
  });

  return { pullRequestUrls, prBranchName };
}
