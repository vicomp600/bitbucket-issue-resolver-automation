export async function run({ repos, branch }) {
  const workspace = process.env.BITBUCKET_WORKSPACE;
  const bitbucketAuth = Buffer.from(
    `${process.env.BITBUCKET_USERNAME}:${process.env.BITBUCKET_API_KEY}`
  ).toString("base64");

  async function fetchTree(repoSlug) {
    const response = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/src/${branch}/?pagelen=100`,
      { headers: { Authorization: `Basic ${bitbucketAuth}` } }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bitbucket ${response.status} for ${repoSlug}: ${error}`);
    }
    const data = await response.json();
    return (data.values ?? []).map((file) => file.path);
  }

  const results = await Promise.all(
    repos.map(async (repoSlug) => {
      try {
        const paths = await fetchTree(repoSlug);
        return { repoSlug, paths, error: null };
      } catch (error) {
        return { repoSlug, paths: [], error: error.message };
      }
    })
  );

  for (const result of results) {
    if (result.error)
      console.warn(
        `⚠️ Could not fetch tree for ${result.repoSlug}: ${result.error}`
      );
  }

  const repoTrees = {};
  for (const result of results) repoTrees[result.repoSlug] = result.paths;

  return { repoTrees };
}
