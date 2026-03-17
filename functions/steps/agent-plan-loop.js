import { GoogleGenAI } from "@google/genai";

export async function run({
  mondayItemId,
  mondayUrl,
  repos,
  branch,
  userContext,
  channelId,
  userId,
  itemName,
  mondayContext,
  thread_ts,
  repoTrees,
}) {
  const workspace = process.env.BITBUCKET_WORKSPACE;
  const bitbucketUsername = process.env.BITBUCKET_USERNAME;
  const bitbucketApiKey = process.env.BITBUCKET_API_KEY;
  const bitbucketAuth = Buffer.from(
    `${bitbucketUsername}:${bitbucketApiKey}`
  ).toString("base64");
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });

  // ── Bitbucket API helpers ─────────────────────────────────────────────

  async function bitbucketGet(path) {
    const response = await fetch(`https://api.bitbucket.org/2.0${path}`, {
      headers: { Authorization: `Basic ${bitbucketAuth}` },
    });
    if (!response.ok) throw new Error(`Bitbucket ${response.status}: ${path}`);
    return response;
  }

  // ── Resolve branch → commit hash per repo ────────────────────────────
  // Branch names with slashes (e.g. "feature/foo") are ambiguous in
  // Bitbucket's /src/{node}/{path} URL — the API mis-parses the branch name
  // as part of the path. Resolving to a commit hash avoids this entirely.

  const branchRefs = {};
  await Promise.all(
    repos.map(async (repoSlug) => {
      try {
        const response = await bitbucketGet(
          `/repositories/${workspace}/${repoSlug}/refs/branches/${encodeURIComponent(
            branch
          )}`
        );
        const data = await response.json();
        branchRefs[repoSlug] = data.target.hash;
      } catch {
        branchRefs[repoSlug] = branch; // fallback for simple branch names without slashes
      }
    })
  );

  // ── Tools ────────────────────────────────────────────────────────────

  async function getFileTree(repoSlug, dirPath = "", maxDepth = 2) {
    const ref = branchRefs[repoSlug] ?? branch;
    const pathSegment = dirPath ? `/${dirPath}/` : "/";
    const response = await bitbucketGet(
      `/repositories/${workspace}/${repoSlug}/src/${ref}${pathSegment}?pagelen=100`
    );
    const data = await response.json();
    const entries = data.values ?? [];

    if (maxDepth <= 0) return entries;

    // For directories, recursively fetch their contents
    const results = await Promise.all(
      entries.map(async (entry) => {
        if (entry.type === "commit_directory") {
          try {
            const children = await getFileTree(
              repoSlug,
              entry.path,
              maxDepth - 1
            );
            return [entry, ...children];
          } catch {
            return [entry]; // if subdirectory fails, just return the dir itself
          }
        }
        return [entry];
      })
    );

    return results.flat();
  }

  async function listRepositories() {
    const response = await bitbucketGet(
      `/repositories/${workspace}?pagelen=50`
    );
    const data = await response.json();
    return data.values.map((repo) => ({ slug: repo.slug, name: repo.name }));
  }

  async function readFile(repoSlug, filePath, fileBranch, startLine, endLine) {
    const ref = fileBranch ?? branchRefs[repoSlug] ?? branch;
    const response = await bitbucketGet(
      `/repositories/${workspace}/${repoSlug}/src/${ref}/${filePath}`
    );
    const content = await response.text();
    const lines = content.split("\n");
    const totalLines = lines.length;

    const LINE_LIMIT = 4000;

    // If a specific range is requested, slice to that range
    if (startLine != null || endLine != null) {
      const from = Math.max(0, (startLine ?? 1) - 1);
      const to = endLine != null ? endLine : from + LINE_LIMIT;
      const sliced = lines.slice(from, to);
      const header = `[Lines ${from + 1}–${Math.min(
        to,
        totalLines
      )} of ${totalLines} total]\n`;
      return header + sliced.join("\n");
    }

    if (totalLines > LINE_LIMIT) {
      return (
        lines.slice(0, LINE_LIMIT).join("\n") +
        `\n\n[TRUNCATED — ${totalLines} lines total, showing first ${LINE_LIMIT}. Call read_file again with start_line=${
          LINE_LIMIT + 1
        } to continue.]`
      );
    }
    return content;
  }

  async function searchCodeViaIndexApi(repoSlug, searchQuery, fileExtension) {
    let searchQueryString = `repo:${repoSlug} "${searchQuery}"`;
    if (fileExtension) searchQueryString += ` ext:${fileExtension}`;

    const encodedQuery = encodeURIComponent(searchQueryString);
    const response = await bitbucketGet(
      `/workspaces/${workspace}/search/code?search_query=${encodedQuery}&pagelen=30`
    );
    const data = await response.json();

    const matches = [];
    for (const searchHit of data.values ?? []) {
      for (const contentMatch of searchHit.content_matches ?? []) {
        for (const matchedLine of contentMatch.lines ?? []) {
          const isMatchedLine = matchedLine.segments?.some(
            (segment) => segment.match
          );
          if (isMatchedLine) {
            matches.push({
              file_path: searchHit.file.path,
              line_number: matchedLine.line,
              line_content: matchedLine.segments
                .map((segment) => segment.text)
                .join(""),
              context_before: "",
              context_after: "",
            });
          }
        }
      }
    }

    return matches.slice(0, 50);
  }

  async function searchCode(repoSlug, searchQuery, fileExtension) {
    // Primary: use Bitbucket's workspace code search API (searches full repo regardless of depth)
    try {
      const apiResults = await searchCodeViaIndexApi(
        repoSlug,
        searchQuery,
        fileExtension
      );
      if (apiResults.length > 0) return apiResults;
    } catch {
      // Fall through to tree-based search
    }

    // Fallback: fetch a deeper file tree and search file contents manually
    const deepTree = await getFileTree(repoSlug, "", 4);
    let filesToSearch = deepTree
      .filter((entry) => entry.type !== "commit_directory")
      .map((entry) => entry.path);

    if (fileExtension) {
      filesToSearch = filesToSearch.filter((filePath) =>
        filePath.endsWith(`.${fileExtension}`)
      );
    }

    // Cap at 100 files to avoid excessive API calls
    filesToSearch = filesToSearch.slice(0, 100);

    const matches = [];
    const queryLower = searchQuery.toLowerCase();

    await Promise.all(
      filesToSearch.map(async (filePath) => {
        try {
          const content = await readFile(repoSlug, filePath);
          const lines = content.split("\n");

          lines.forEach((line, index) => {
            if (line.toLowerCase().includes(queryLower)) {
              matches.push({
                file_path: filePath,
                line_number: index + 1,
                line_content: line.trim(),
                context_before: lines[index - 1]?.trim() ?? "",
                context_after: lines[index + 1]?.trim() ?? "",
              });
            }
          });
        } catch {
          // File may be binary or inaccessible — skip it
        }
      })
    );

    return matches.slice(0, 50);
  }

  // ── Tool schemas (what Gemini sees) ──────────────────────────────────

  const MAX_FILES_TO_EDIT = 8;
  const MIN_FIX_CONFIDENCE = 75;

  const geminiTools = [
    {
      functionDeclarations: [
        {
          name: "list_repos",
          description:
            "List all available repos in the workspace. Use this when the issue involves a service you don't have a repo slug for.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        {
          name: "get_file_tree",
          description:
            "List files and directories recursively (up to 2 levels deep). Only call this for subdirectories not already covered by the root-level tree in the prompt.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              repo_slug: {
                type: "string",
                description: "Bitbucket repo slug",
              },
              path: {
                type: "string",
                description: "Directory path to list. Empty string for root.",
              },
            },
            required: ["repo_slug"],
          },
        },
        {
          name: "read_file",
          description:
            "Read the contents of a specific file. Output is truncated at 4000 lines. If the file is longer, call again with start_line to read the next chunk.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              repo_slug: { type: "string" },
              file_path: {
                type: "string",
                description: "Full path to the file",
              },
              branch: {
                type: "string",
                description:
                  "Branch to read from. Defaults to the target branch.",
              },
              start_line: {
                type: "number",
                description:
                  "1-based line number to start reading from. Use to paginate large files.",
              },
              end_line: {
                type: "number",
                description:
                  "1-based line number to stop reading at (inclusive).",
              },
            },
            required: ["repo_slug", "file_path"],
          },
        },
        {
          name: "search_code",
          description:
            "Search for a string across files in a repo. Returns matching lines with one line of context above and below.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              repo_slug: { type: "string" },
              query: {
                type: "string",
                description: "Text to search for (case-insensitive)",
              },
              file_extension: {
                type: "string",
                description:
                  "Limit search to files with this extension, e.g. 'ts', 'vue'",
              },
            },
            required: ["repo_slug", "query"],
          },
        },
        {
          name: "write_fix",
          description:
            "Your required final action. Submit your findings and, if confident, targeted search/replace edits for each file. A separate step will apply your edits to the original files, commit them, and open the pull request. You must call this to finish — do not end without calling it.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                enum: ["fix", "analyze"],
                description:
                  "'fix' if you have read the relevant files and know exactly what to change (confidence ≥ " +
                  MIN_FIX_CONFIDENCE +
                  "). 'analyze' if confidence is too low, the root cause is unclear, or the change requires architectural decisions.",
              },
              confidence: {
                type: "number",
                description: `0-100. A fix requires confidence ≥ ${MIN_FIX_CONFIDENCE}.`,
              },
              analysis: {
                type: "string",
                description:
                  "Always required. Summarize root cause, relevant files, and what you found.",
              },
              files_to_modify: {
                type: "array",
                description: `Required when decision=fix. Maximum ${MAX_FILES_TO_EDIT} files.`,
                items: {
                  type: "object",
                  properties: {
                    repo_slug: { type: "string" },
                    path: { type: "string" },
                    edits: {
                      type: "array",
                      description:
                        "Targeted search/replace edits. Each `search` string must be copied verbatim from the file and must match exactly one location.",
                      items: {
                        type: "object",
                        properties: {
                          search: {
                            type: "string",
                            description:
                              "Exact multi-line text to find in the file, copied verbatim from read_file output. Must be unique within the file.",
                          },
                          replace: {
                            type: "string",
                            description:
                              "The replacement text with the fix applied.",
                          },
                        },
                        required: ["search", "replace"],
                      },
                    },
                  },
                  required: ["repo_slug", "path", "edits"],
                },
              },
              fix_description: {
                type: "string",
                description:
                  "Human-readable summary of what the fix does. Required when decision=fix.",
              },
              pr_title: {
                type: "string",
                description:
                  "A concise, clear English title for the pull request describing what the fix does (e.g. 'Fix analytics consent default to enabled for new users'). Must be in English regardless of the Monday task language. Required when decision=fix.",
              },
              suggested_approach: {
                type: "string",
                description:
                  "Numbered steps for a developer to follow. Required when decision=analyze.",
              },
            },
            required: ["decision", "confidence", "analysis"],
          },
        },
      ],
    },
  ];

  // ── System prompt ────────────────────────────────────────────────────

  const repoTreeSummary = Object.entries(repoTrees)
    .map(
      ([repo, paths]) =>
        `${repo}:\n${paths.map((filePath) => `  ${filePath}`).join("\n")}`
    )
    .join("\n\n");

  const systemPrompt = `You are a senior software engineer triaging a bug or feature issue. Investigate the codebase and either implement a targeted fix or produce a detailed analysis.

## Issue
Title: ${itemName}
URL: ${mondayUrl}

## Context from Monday
${mondayContext}
${userContext ? `## Additional context from the user\n${userContext}\n` : ""}
## Repositories to investigate
${repos.join(", ")} — target branch: ${branch}

## Root-level file tree
${repoTreeSummary}

## How to work
1. Before doing anything, list out specific investigation steps based on the issue. Identify which files or modules are likely involved.
2. The root-level file tree for each repo is already provided above — do not call get_file_tree for the root. Only use get_file_tree to explore subdirectories that look relevant to the issue.
3. Use search_code to find function names, error messages, or patterns mentioned in the issue.
4. Choose decision="fix" if: you have read the relevant files, the root cause is clear and isolated, the change touches ≤${MAX_FILES_TO_EDIT} files, and you have confidence ≥${MIN_FIX_CONFIDENCE}. For each file, provide targeted search/replace edits. The \`search\` field must be an exact multi-line snippet copied verbatim from the file (include enough surrounding lines of context to be unique). The \`replace\` field is the same snippet with your fix applied. Do NOT rewrite entire files. Do NOT add comments that narrate what the code does (e.g. "// updated to fix X", "// changed this line"). Do NOT use placeholder or filler comments like "// rest of the code remains the same". Only include comments if the original code had them or if they are truly necessary to understand the change. A downstream step will apply your edits to the original files, commit them, and open the PR.
   - Set \`pr_title\` to a concise English title describing the fix (e.g. "Fix analytics consent defaulting to disabled for new users"). Derive the title from your findings — do NOT copy the Monday task title verbatim, and always write it in English regardless of the task language.
   - Write \`analysis\` as clear, human-readable prose or bullet points. Cover: what the root cause is, which files/functions are involved, and why the bug occurs. Do NOT include AI self-narration (e.g. "I will now...", "Let me check...", "Based on my investigation..."). Write as if explaining to a developer reviewing the PR.
5. Choose decision="analyze" if: confidence is <${MIN_FIX_CONFIDENCE}, the change touches >${MAX_FILES_TO_EDIT} files, the fix requires architecture decisions, or you could not find the relevant files.
6. When analyzing: reference exact file paths, line numbers, and function names. Be specific.
7. PR branch format: fix/monday-${mondayItemId}-{short-slug}
8. You must call write_fix as your final action. Do not finish without calling it.`;

  // ── Agent loop ───────────────────────────────────────────────────────

  function parseRetryDelayMs(error) {
    try {
      const jsonMatch = error.message?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const retryInfo = parsed.error?.details?.find((detail) =>
          detail["@type"]?.includes("RetryInfo")
        );
        if (retryInfo?.retryDelay) {
          const seconds = parseInt(retryInfo.retryDelay, 10);
          if (!isNaN(seconds)) return seconds * 1000 + 500; // +500ms buffer
        }
      }
    } catch {
      // couldn't parse — fall through to exponential backoff
    }
    return null;
  }

  async function sendAiMessageWithRetry(chat, message, maxRetries = 3) {
    const retryableMessages = [
      "high demand",
      "unavailable",
      "503",
      "overloaded",
      "quota",
      "resource_exhausted",
      "429",
    ];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await chat.sendMessage({ message });
      } catch (error) {
        const isRetryable = retryableMessages.some((msg) =>
          error.message?.toLowerCase().includes(msg)
        );

        if (!isRetryable || attempt === maxRetries) throw error;

        const waitMs = parseRetryDelayMs(error) ?? 2000 * Math.pow(2, attempt); // use API-provided delay, or 2s/4s/8s
        console.log(
          `Gemini unavailable, retrying in ${waitMs / 1000}s (attempt ${
            attempt + 1
          }/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  const chat = ai.chats.create({
    model: "gemini-3.1-flash-lite-preview",
    config: { systemInstruction: systemPrompt, tools: geminiTools },
  });

  let writeFix = null;
  let nextMessage = `Investigate and fix or analyze: "${itemName}". Start by breaking down what needs to be investigated, then use your tools.`;
  const agentThoughts = [];

  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      console.log(`\n── Iteration ${iteration + 1} ──`);
      console.log(
        "Sending message type:",
        Array.isArray(nextMessage) ? "tool responses" : "text"
      );

      const response = await sendAiMessageWithRetry(chat, nextMessage);

      console.log("Response text:", response.text?.slice(0, 200) ?? "(none)");
      console.log("Tokens used:", response.usageMetadata?.totalTokenCount);
      console.log(
        "Function calls:",
        response.functionCalls?.map((call) => call.name) ?? "(none)"
      );

      if (response.text) agentThoughts.push(response.text);

      const toolCalls = response.functionCalls;
      if (!toolCalls || toolCalls.length === 0) {
        console.log("No tool calls — loop ending");
        break;
      }

      const toolResponses = [];

      for (const call of toolCalls) {
        console.log(
          `Dispatching tool: ${call.name}`,
          JSON.stringify(call.args)
        );
        let result;
        try {
          if (call.name === "get_file_tree") {
            const treeEntries = await getFileTree(
              call.args.repo_slug,
              call.args.path
            );
            result = treeEntries.map((entry) => entry.path);
            console.log(`get_file_tree → ${result.length} entries`);
          } else if (call.name === "read_file") {
            result = await readFile(
              call.args.repo_slug,
              call.args.file_path,
              call.args.branch,
              call.args.start_line,
              call.args.end_line
            );
            console.log(`read_file → ${result.length} chars`);
          } else if (call.name === "list_repos") {
            result = await listRepositories();
            console.log(`list_repos → ${result.length} repositories`);
          } else if (call.name === "search_code") {
            result = await searchCode(
              call.args.repo_slug,
              call.args.query,
              call.args.file_extension
            );
            console.log(`search_code → ${result.length} matches`);
          } else if (call.name === "write_fix") {
            const MAX_LINES_PER_EDIT = 30;
            const proposedFix = call.args;
            const filesToModify = proposedFix.files_to_modify ?? [];

            const filesWithOversizedEdits =
              proposedFix.decision === "fix"
                ? filesToModify.filter((file) =>
                    (file.edits ?? []).some((edit) => {
                      const editLineCount = edit.search.split("\n").length;
                      return editLineCount > MAX_LINES_PER_EDIT;
                    })
                  )
                : [];

            if (filesWithOversizedEdits.length > 0) {
              const affectedPaths = filesWithOversizedEdits
                .map((file) => file.path)
                .join(", ");
              console.log(
                `write_fix rejected — oversized edits in: ${affectedPaths}`
              );
              result = {
                error:
                  `Your edits for ${affectedPaths} are too large. ` +
                  `Each search block must only contain the specific lines being changed ` +
                  `plus a few lines of surrounding context (max ~${MAX_LINES_PER_EDIT} lines). ` +
                  `Do NOT use the entire file content as a search block. ` +
                  `Break large changes into multiple smaller, targeted edits.`,
              };
            } else {
              writeFix = proposedFix;
              result = { acknowledged: true };
              console.log("write_fix accepted");
            }
          } else {
            console.warn("Unknown tool called:", call.name);
            result = { error: `Unknown tool: ${call.name}` };
          }
        } catch (error) {
          console.error(`Tool ${call.name} threw:`, error.message);
          result = { error: error.message };
        }

        toolResponses.push({
          functionResponse: { name: call.name, response: { result } },
        });
      }
      if (writeFix) break;
      nextMessage = toolResponses;
    }
  } catch (error) {
    // Post error to the Slack thread so the user isn't left hanging
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channelId,
        thread_ts,
        text: `⚠️ The AI model couldn't complete the analysis (might be currently overloaded). Please try again in a few minutes.\n\n_Error: ${error.message}_`,
      }),
    });
    throw error;
  }

  if (!writeFix) {
    writeFix = {
      decision: "analyze",
      confidence: 0,
      analysis: agentThoughts.length
        ? agentThoughts.join("\n\n---\n\n")
        : "Agent did not produce any output.",
      suggested_approach:
        "Review manually — the agent loop ended without calling write_fix.",
    };
  }

  return {
    writeFix,
    itemName,
    mondayUrl,
    thread_ts,
    channelId,
    userId,
    repos,
    branch,
    mondayItemId,
  };
}
