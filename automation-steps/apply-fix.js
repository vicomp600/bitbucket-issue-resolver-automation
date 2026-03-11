// Pipedream step: apply-fix
// Creates a branch, commits all file changes, and opens a pull request.
// Only runs when the agent's decision is "fix". Skips silently for "analyze".
export default defineComponent({
  async run({ steps, $ }) {
    const {
      writeFix,
      itemName,
      mondayUrl,
      thread_ts,
      channelId,
      branch: targetBranch,
      mondayItemId,
    } = steps.notify_plan.$return_value;

    // Nothing to do for analysis-only results
    if (writeFix.decision !== "fix") {
      return { skipped: true, reason: "decision was analyze" };
    }

    const workspace = process.env.BITBUCKET_WORKSPACE;
    const bitbucketUsername = process.env.BITBUCKET_API_USERNAME;
    const bitbucketApiKey = process.env.BITBUCKET_API_TOKEN;
    const bitbucketAuth = Buffer.from(
      `${bitbucketUsername}:${bitbucketApiKey}`
    ).toString("base64");

    async function bitbucketRequest(path, options = {}) {
      const response = await fetch(`https://api.bitbucket.org/2.0${path}`, {
        headers: {
          Authorization: `Basic ${bitbucketAuth}`,
          ...options.headers,
        },
        ...options,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Bitbucket ${response.status} ${path}: ${body}`);
      }
      return response;
    }

    // Get the latest commit hash of the target branch so we can branch from it
    async function getLatestCommitHash(repoSlug, branchName) {
      const response = await bitbucketRequest(
        `/repositories/${workspace}/${repoSlug}/refs/branches/${branchName}`
      );
      const data = await response.json();
      return data.target.hash;
    }

    // Commit one or more files to a new branch in a single API call.
    // Bitbucket's POST /src endpoint accepts multipart form data where each
    // file path is a field key and its new content is the value.
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

    async function createPullRequest(repoSlug, prBranch, title, description) {
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

    // ── Group file changes by repo ────────────────────────────────────────

    const filesByRepo = {};
    for (const fileChange of writeFix.files_to_modify) {
      if (!filesByRepo[fileChange.repo_slug]) {
        filesByRepo[fileChange.repo_slug] = [];
      }
      filesByRepo[fileChange.repo_slug].push(fileChange);
    }

    // ── Create a short slug from the issue name for the branch name ───────

    const issueSlug = itemName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);

    const prBranchName = `fix/monday-${mondayItemId}-${issueSlug}`;
    const commitMessage = `fix: ${writeFix.fix_description}\n\nMonday issue: ${mondayUrl}`;

    // ── Commit files and open PRs ─────────────────────────────────────────

    const pullRequestUrls = [];

    for (const [repoSlug, filesToCommit] of Object.entries(filesByRepo)) {
      const sourceCommitHash = await getLatestCommitHash(
        repoSlug,
        targetBranch
      );

      await commitFilesToNewBranch(
        repoSlug,
        prBranchName,
        commitMessage,
        filesToCommit,
        sourceCommitHash
      );

      const prTitle = `[${mondayItemId}] ${itemName}`;
      const prDescription = [
        writeFix.fix_description,
        "",
        `**Root cause analysis:**`,
        writeFix.analysis,
        "",
        `**Monday issue:** ${mondayUrl}`,
      ].join("\n");

      const pullRequest = await createPullRequest(
        repoSlug,
        prBranchName,
        prTitle,
        prDescription
      );

      pullRequestUrls.push(pullRequest.links.html.href);
      console.log(`PR created: ${pullRequest.links.html.href}`);
    }

    // ── Notify Slack with PR links ────────────────────────────────────────

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
  },
});
