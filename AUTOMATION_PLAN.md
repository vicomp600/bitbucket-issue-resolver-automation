# Taglibot — AI Issue Automation Agent

---

## Implementation Status

pipedream-code.js is current code for the agent loop step (unless told otherwise)

### ✅ Done

**Workflow 1: `fix-issue-slack`** (Pipedream — deployed)

- HTTP trigger, Authorization: None, Event Data: Full HTTP request
- Slash command `/fix-issue` registered in Slack App → Request URL = Pipedream trigger URL
- Single code step: verifies request via `body.token` (Slack verification token — NOT HMAC, because Pipedream parses the body before the code runs making HMAC unworkable), opens modal via `views.open`
- Modal fields: Monday Task URL (required), Repo(s) multi-select (9 repos listed), Other repos text field, Target branch (optional, default: `staging`), Additional context (optional multiline)
- Modal `callback_id: "fix_issue_modal"`, `private_metadata` stores `{ channelId, userId }`
- Env vars in Pipedream project: `SLACK_VERIFICATION_TOKEN`, `SLACK_BOT_TOKEN`

---

### 🔲 TODO — Workflow 2: `fix-issue-brain` (the main pipeline)

**Trigger:** New Interaction Events (Instant) — Slack account, channel: taglibot

> In Slack App settings: **Interactivity & Shortcuts → Request URL** must point to this workflow's Pipedream trigger URL.

**Before writing any code — break the task into these pieces and implement one at a time:**

---

**Step 1 — Parse + validate modal submission**

```
payload = JSON.parse(steps.trigger.event.body.payload)

Guard rails (exit early if not our modal):
  if (payload.type !== "view_submission") return
  if (payload.view.callback_id !== "fix_issue_modal") return

Extract values:
  const values = payload.view.state.values
  const mondayUrl    = values.monday_url.value.value
  const selectedRepos = values.repo_select.value.selected_options.map(o => o.value)
  const otherRepos   = (values.repo_other.value.value ?? "").split(" ").filter(Boolean)
  const repos        = [...selectedRepos, ...otherRepos]
  const branch       = values.branch.value.value || "staging"
  const userContext  = values.context.value.value ?? ""
  const { channelId, userId } = JSON.parse(payload.view.private_metadata)

Validate Monday URL, extract item ID:
  const itemIdMatch = mondayUrl.match(/\/items\/(\d+)/)
  if (!itemIdMatch) → post ephemeral error to user and STOP
  const mondayItemId = itemIdMatch[1]
```

---

**Step 2 — Fetch Monday item title + post "Analyzing..." to Slack**

Fetch the Monday item title FIRST so the initial message clearly identifies which issue
is being worked on (important when multiple team members use the bot simultaneously).

```
1. GraphQL to Monday API to get just the item name (fast, before heavy processing):
   query { items(ids: [mondayItemId]) { name } }
   Env var: MONDAY_API_TOKEN

2. POST chat.postMessage:
   channel: channelId
   text: "🔍 Analyzing *[{itemName}]({mondayUrl})* across repos: {repos.join(', ')}..."

3. Save returned ts as thread_ts — ALL subsequent messages use this thread_ts
```

---

**Step 3 — Fetch full Monday context**

```
Second GraphQL query for full item detail:
  query { items(ids: [mondayItemId]) {
    name
    description (the item body)
    updates { text_body, created_at, creator { name } }  ← comments/thread
    column_values { title, text }
  }}

Cap combined text at ~8000 chars (title + description + comments, newest first)
```

---

**Step 4 — Fetch Bitbucket file tree (for each repo)**

> ⚠️ Bitbucket App Passwords are deprecated. New app passwords cannot be created
> since September 2025 and all app passwords stop working June 9, 2026.
> Use **Bitbucket API Tokens** (Bearer auth) instead.

```
Auth: Authorization: Bearer {BITBUCKET_API_KEY}
GET https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}/src/?pagelen=100

Create token at:
  Bitbucket → Personal settings → Access tokens (personal token)
  OR: bitbucket.org/{workspace}/workspace/settings/access-tokens (workspace token)

Scopes needed (minimal):
  - repository:read
  - pullrequest:write

Env vars: BITBUCKET_WORKSPACE, BITBUCKET_API_KEY
Returns: list of file paths only — do NOT fetch file contents here
Run for each repo in parallel if multiple repos provided
```

---

**Step 5 — Run Gemini agent loop**

> Break this into sub-steps mentally: (a) define tools, (b) build prompt, (c) run loop

```
SDK: @google/genai  ← NOT @google/generative-ai (deprecated Nov 2025)
Model: gemini-2.5-flash (free tier: 10 RPM / 250 RPD / 1M token context)
Env var: GOOGLE_AI_API_KEY  (from aistudio.google.com → Get API key)

(a) Define 4 tools:

  get_file_tree(repo_slug, path?)
    → GET /2.0/repositories/{workspace}/{repo}/src/{path}
    → returns string[] of file paths

  read_file(repo_slug, file_path, branch?)
    → GET /2.0/repositories/{workspace}/{repo}/src/{branch}/{file_path}
    → returns file content string, TRUNCATE at 2000 lines with notice

  search_code(repo_slug, query, file_extension?)
    → fetch relevant files via file tree, read each, grep in-memory
    → returns [{file_path, line_number, line_content}] + 2 lines context

  write_fix  ← TERMINAL TOOL (agent MUST call this to end the loop)
    Input: {
      decision: "fix" | "analyze"
      confidence: number (0–100)
      analysis: string  (always present)
      files_to_modify?: [{path: string, new_content: string}]  // fix only
      fix_description?: string
      suggested_approach?: string  // analyze only
    }

(b) System prompt key points:
  - Role: senior engineer triaging a bug/issue
  - Issue context: title, description, comments (injected)
  - User-provided context injected as: "User context: {userContext}"
  - BEFORE DOING ANYTHING: break the issue down into small investigation steps,
    identify which files/modules are likely involved, then read them one by one
  - Decision rule: fix if change is small/isolated (≤5 files, confidence ≥75); else analyze
  - Use get_file_tree first, then selectively read_file — do NOT read everything
  - When analyzing: name exact files, line numbers, function names — be specific
  - MUST call write_fix as the final action — do not end without calling it
  - PR branch name format: fix/monday-{mondayItemId}-{short-slug}

(c) Loop (max 10 iterations):
  const chat = ai.chats.create({ model: "gemini-2.5-flash", config: { tools } })
  let done = false
  for (let i = 0; i < 10 && !done; i++):
    response = await chat.sendMessage({ message })
    if response.functionCalls:
      for each call: dispatch to tool handler → collect result
      send all functionResponse parts back
    else:
      done = true  ← no more tool calls = agent is finished without write_fix
  if write_fix not called → treat as analyze, use last response text as analysis
```

---

**Step 6 — Execute decision**

```
if decision === "fix" AND confidence >= 75:

  a. Create branch via Bitbucket API:
     POST /2.0/repositories/{workspace}/{repo}/refs/branches
     { "name": "fix/monday-{mondayItemId}", "target": { "hash": "{branch_head_commit}" } }

  b. For each file in files_to_modify (max 5 files):
     - If new file: POST /2.0/repositories/{workspace}/{repo}/src
     - If existing file:
         GET current file to retrieve current commit hash
         POST updated content to /2.0/repositories/{workspace}/{repo}/src
     (Bitbucket's src API uses multipart form, not JSON)

  c. Open PR:
     POST /2.0/repositories/{workspace}/{repo}/pullrequests
     {
       title: "[Taglibot] {mondayItemTitle}",
       description: "Fixes: {mondayUrl}\n\n{fix_description}\n\nTriggered by: @{userId}",
       source: { branch: { name: "fix/monday-{mondayItemId}" } },
       destination: { branch: { name: branch } }
     }

else (analyze):
  No Bitbucket writes. Proceed to Step 7 with analysis text.
```

---

**Step 7 — Post result to Slack thread**

```
chat.postMessage with thread_ts (from Step 2) — reply stays in the thread

FIX path:
  "✅ PR opened: <{pr_url}|{pr_title}>
   {fix_description}"

ANALYZE path — Block Kit sections:
  Header: "🔍 Analysis: {mondayItemTitle}"
  Section: Issue summary (2–3 lines)
  Section: Root cause — specific files + line numbers
  Section: Suggested approach — numbered steps
  Section: Relevant files — bulleted list with paths
  Context: "Confidence too low to auto-fix ({confidence}%). Review suggested approach above."
```

---

### 🔲 TODO — Workflow 3: `fix-issue-threads` (follow-up conversations)

**Trigger:** New Message In Channels (Instant) — channel: taglibot

**Guard conditions (check first, exit early):**

```
const event = steps.trigger.event
if (!event.thread_ts) return        // not a thread reply
if (event.bot_id) return            // ignore bot's own messages
if (event.subtype) return           // ignore join/leave/etc system messages
if (event.text?.startsWith("🔍")) return  // ignore bot's own analysis messages
```

**Steps:**

```
1. Fetch thread: GET conversations.replies?channel={event.channel}&ts={event.thread_ts}
2. Format history: [{role: "user"|"bot", text}] sorted oldest-first, skip bot's own messages
3. Re-run Gemini agent (same 4 tools, same loop) with prior conversation prepended to prompt
4. Reply in same thread: chat.postMessage with thread_ts = event.thread_ts
```

---

### 🔲 TODO — Slack App Configuration (api.slack.com/apps)

**Interactivity & Shortcuts:**

- Request URL = Workflow 2 (`fix-issue-brain`) Pipedream trigger URL

**Event Subscriptions:**

- Request URL = Workflow 3 (`fix-issue-threads`) Pipedream trigger URL
- Subscribe to bot events: `message.channels`, `message.groups`

**OAuth & Permissions — Bot Token Scopes needed:**

- `chat:write` — post messages
- `commands` — slash command
- `channels:history` — read thread history in public channels
- `groups:history` — read thread history in private channels

---

### 🔲 TODO — Bitbucket Setup

1. Go to: **Bitbucket → Personal settings → Access tokens**
   (or workspace token: `bitbucket.org/{workspace}/workspace/settings/access-tokens`)
2. Create token with **only** these scopes:
   - `Repositories: Read`
   - `Pull requests: Write`
3. Add to Pipedream env vars: `BITBUCKET_API_KEY`, `BITBUCKET_WORKSPACE`

> Note: App Passwords are deprecated (cannot create new ones since Sept 2025,
> stop working entirely June 9, 2026). Use API tokens with Bearer auth only.

---

### 🔲 TODO — Remaining Pipedream Env Vars to Add

| Variable              | Where to get it                                          |
| --------------------- | -------------------------------------------------------- |
| `MONDAY_API_TOKEN`    | Monday.com → Profile picture → Developers → API v2 Token |
| `BITBUCKET_WORKSPACE` | Your workspace slug (from bitbucket.org/{workspace})     |
| `BITBUCKET_API_KEY`   | Bitbucket → Personal settings → Access tokens            |
| `GOOGLE_AI_API_KEY`   | aistudio.google.com → Get API key (free, no credit card) |

---

## Context

The goal is to build an AI-powered automation bot ("taglibot") that bridges Slack, Monday.com, and Bitbucket. When triggered by a Slack slash command, it fetches a Monday.com issue, reads the relevant Bitbucket codebase, and uses Claude to either: (a) automatically implement a fix and open a PR, or (b) produce a structured analysis if the fix is too complex. This reduces the manual loop of reading issues → navigating code → deciding what to do.

---

## Tech Stack

| Layer              | Choice                                                          | Reason                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform / hosting | **Pipedream**                                                   | No server to host, built-in Slack/Monday/Bitbucket integrations, secrets management, HTTPS endpoint included                                             |
| Language           | **TypeScript** (Node.js)                                        | User preference; Anthropic SDK is first-class TS                                                                                                         |
| AI brain           | **Google Gen AI SDK** (`@google/genai`) with `gemini-2.5-flash` | Free tier (10 RPM / 250 RPD), 1M token context window, function calling API for agentic loop. Note: `@google/generative-ai` is deprecated as of Nov 2025 |
| Slack              | Pipedream Slack trigger + `@slack/web-api` for posting          | Slash command trigger; Pipedream handles the 3s timeout automatically                                                                                    |
| Monday.com         | Pipedream HTTP step with GraphQL                                | Read-only: item title, description, update threads                                                                                                       |
| Bitbucket          | Bitbucket REST API v2 via `axios`/`fetch`                       | App Password with minimal scopes; read repos, write PRs only                                                                                             |

---

## Architecture

```
1) User types: /fix-issue  →  Modal opens immediately

   ┌─────────────────────────────────┐
   │  Fix Issue with Taglibot        │
   │  Monday Task URL *  [________]  │
   │  Repo slug(s) *     [________]  │
   │  Target branch      [main    ]  │
   │  Additional context [________]  │
   │                [Cancel][Submit] │
   └─────────────────────────────────┘

2) User submits  →  Pipedream /slack/interactions webhook fires

PIPEDREAM PIPELINE WORKFLOW
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Step 1: validate_input                                          │
│    Slack already enforced required fields in the modal.          │
│    Server-side: validate Monday URL format, parse item ID,       │
│    validate branch name format.                                  │
│    On error: post ephemeral error to user and STOP.              │
│                                                                  │
│  Step 2: fetch_monday_context                                    │
│    GraphQL → item title, description, comments, status          │
│                                                                  │
│  Step 3: fetch_repo_structure                                    │
│    Bitbucket REST → file tree (paths only, no content yet)       │
│                                                                  │
│  Step 4: run_gemini_agent  ← CORE STEP                          │
│    Google Generative AI SDK agentic loop with 4 tools:           │
│      • get_file_tree   - list files in repo/subdirectory         │
│      • read_file       - read a specific file (truncated)        │
│      • search_code     - grep-style search across repo files     │
│      • write_fix       - terminal tool: submit decision          │
│    Loop until write_fix called OR max 10 iterations              │
│                                                                  │
│  Step 5: execute_decision                                        │
│    if decision == "fix" AND confidence >= 75:                    │
│      → create branch: fix/monday-{item_id}                       │
│      → commit file changes via Bitbucket Files API               │
│      → open PR (source: fix branch → destination: main/develop) │
│    else:                                                         │
│      → format structured analysis (root cause, files, plan)     │
│                                                                  │
│  Step 6: notify_slack                                            │
│    FIX: "PR opened: [title](url)" + change summary              │
│    ANALYZE: rich Slack Block Kit message with findings           │
│    → ALL responses posted in a thread (thread_ts = chat ID)     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

THREAD FOLLOW-UP FLOW (continuation of existing chat)
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  User replies in the bot's thread with a follow-up message       │
│  → Pipedream /slack/events fires (app_mention or message event)  │
│                                                                  │
│  Step 1: detect thread context                                   │
│    Extract thread_ts from event payload                          │
│    Fetch full thread history via conversations.replies API       │
│                                                                  │
│  Step 2: run_gemini_agent with history                           │
│    Prepend thread messages to Gemini prompt as prior context     │
│    Agent can reference previous analysis, PR links, decisions    │
│    Same 4 tools available                                        │
│                                                                  │
│  Step 3: reply in same thread                                    │
│    Response posted as a reply → thread stays self-contained      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Claude Agent Tools

The agent runs a tool-use loop. These 4 tools define its capabilities:

### 1. `get_file_tree`

```
Input:  repo_slug, path? (default ""), max_depth? (default 3)
Output: string[] of file paths
Use:    First call to understand repo structure before reading files
```

### 2. `read_file`

```
Input:  repo_slug, file_path, branch? (default "main")
Output: file content string (truncated at 500 lines with notice)
Use:    Read specific files relevant to the issue
```

### 3. `search_code`

```
Input:  repo_slug, query (string/pattern), file_extension? filter
Output: [{file_path, line_number, line_content}] matches + 2 lines context
Use:    Find function names, error strings, class references from issue
Note:   Implemented by fetching files from Bitbucket and searching in-memory
```

### 4. `write_fix` (terminal tool)

```
Input:
  decision: "fix" | "analyze"
  confidence: number (0-100)
  analysis: string (always - summary of findings)
  files_to_modify?: [{path, new_content}]  // only when decision="fix"
  fix_description?: string
  suggested_approach?: string  // only when decision="analyze"
Output: acknowledgement
Use:    REQUIRED final action. Agent MUST call this to end the loop.
        Actual Bitbucket writes happen in Step 5, not here.
```

---

## Bitbucket Permissions (Minimal)

App Password scopes — **only these two**:

- `Repositories: Read`
- `Pull requests: Write`

Nothing else: no admin, no delete, no merge, no webhooks, no pipelines.

Enforced in code: branch creation prefix locked to `fix/`; max 5 files modified per run.

---

## Pipedream Workflow File Structure (GitHub-synced)

```
taglibot/
├── pipedream/
│   ├── steps/
│   │   ├── validate_input.ts       # Parse + validate Monday URL, repo, branch
│   │   ├── fetch_monday.ts         # GraphQL to Monday.com API
│   │   ├── fetch_repo.ts           # Bitbucket file tree prefetch
│   │   ├── gemini_agent.ts         # Agentic loop — imports agent/ modules
│   │   ├── execute_decision.ts     # Branch + commit + PR OR format analysis
│   │   ├── notify_slack.ts         # Post Block Kit message in thread
│   │   └── thread_reply.ts         # Handle follow-up replies: fetch history, re-run agent
│   └── agent/
│       ├── tools.ts                # Tool schemas (Gemini FunctionDeclaration format) + dispatch map
│       ├── tool_handlers.ts        # Implementations: tree, read, search
│       └── prompts.ts              # System prompt template
├── .env.example
└── README.md
```

---

## Slack Interaction Design

The trigger is a slash command that opens a **Slack modal form** — no arguments to memorize.

**User flow:**

1. User types `/fix-issue` in any channel
2. A modal dialog opens instantly with labeled fields
3. User fills in the form and clicks Submit
4. Bot posts "Analyzing..." and runs the pipeline in the background

**Modal fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| Monday Task URL | Short text | Yes | Validated: must match `monday.com/...` pattern |
| Repo slug(s) | Short text | Yes | Space-separated for multiple repos |
| Target branch | Short text | No | Defaults to `main` if empty |
| Additional context | Long text | No | Free-text box: user describes what they think the issue is |

Slack enforces required fields natively in the modal — no custom validation needed for missing fields.
Format validation (valid Monday URL, valid branch name) happens in Step 1 server-side.

**Three Pipedream endpoints required:**

- `POST /slack/slash` — receives `/fix-issue`, opens the modal via `views.open` (must respond < 3s)
- `POST /slack/interactions` — receives `view_submission` payload when user submits the form; triggers the pipeline
- `POST /slack/events` — receives `app_mention` and `message` events for thread replies (follow-up conversations)

**Additional context** is injected into the Gemini system prompt as: `"User-provided context: <text>"` — giving the agent a head start on where to look.

---

## Thread-Based Chat History

Every bot response is posted in a **Slack thread**. The `thread_ts` is the conversation ID — no database needed.

**How it works:**

- Initial result is always posted as the first message in a new thread (using `thread_ts` from the modal submission's originating channel message)
- User can reply directly in that thread: `"Actually focus on the checkout service"` or `"Now go ahead and implement the fix"`
- Bot detects the reply, calls `conversations.replies` to fetch the full thread, formats it as Gemini chat history, and runs the agent again with full context

**Slack API calls needed:**

- `chat.postMessage` with `thread_ts` to reply in a thread
- `conversations.replies` to fetch thread history (requires `channels:history` or `groups:history` scope added to bot token)

**Thread history → Gemini prompt format:**

```
[Prior conversation]
User: <thread message 1>
Bot: <thread message 2>
User: <thread message 3>
...
[Current request]
User: <latest reply>
```

**Slack bot token scopes to add:**

- `channels:history` — read public channel thread history
- `groups:history` — read private channel thread history
- `im:history` — read DM thread history (optional)

---

## System Prompt (Key Instructions to Gemini)

- Role: senior engineer triaging a bug/issue
- Issue context injected: title, description, comments (capped at 8k chars)
- Decision framework: fix if small/isolated change; analyze if touching > 5 files, unclear root cause, or confidence < 75
- REQUIRED: always call `write_fix` as the final action
- Don't read every file — use `get_file_tree` first, then selectively `read_file`
- PR branch name format: `fix/monday-{item_id}-{short-description}`
- When analyzing, be specific: name files, line numbers, function names

---

## Security Model

| Secret                   | Where stored                                        | Scope                                                          |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`        | Pipedream environment variable                      | `chat:write`, `commands`, `channels:history`, `groups:history` |
| `SLACK_SIGNING_SECRET`   | Pipedream (verified by Slack trigger automatically) | -                                                              |
| `MONDAY_API_TOKEN`       | Pipedream environment variable                      | Read-only board access                                         |
| `BITBUCKET_USERNAME`     | Pipedream environment variable                      | -                                                              |
| `BITBUCKET_APP_PASSWORD` | Pipedream environment variable                      | Read repos + write PRs only                                    |
| `GOOGLE_AI_API_KEY`      | Pipedream environment variable                      | Free tier via Google AI Studio                                 |

No database. No persistent storage. All state lives in Monday.com, Bitbucket, and Slack threads.

---

## Key Implementation Constraints

| Concern                                        | Mitigation                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipedream step timeout (30s free / 12min paid) | Use **paid Pipedream** tier; claude-sonnet-4-6 agent loop typically 1-3 min                                                                                                   |
| Token limits on large repos                    | Gemini 1.5 Flash has 1M token context — can include much more code; still use file tree first for efficiency. Truncation fallback at 2000 lines/file                          |
| Slack 3s timeout                               | Pipedream Slack trigger handles ack; use `response_url` for follow-up messages                                                                                                |
| Runaway agent loops                            | `MAX_ITERATIONS = 10`; force-terminate and return partial analysis. Gemini rate limits (free: 10 RPM) also naturally throttle runaway loops                                   |
| Bitbucket SHA requirement                      | GET file before PUT to retrieve current SHA; retry once on SHA conflict                                                                                                       |
| Cost control                                   | **Free tier**: Gemini 2.5 Flash = 10 RPM / 250 RPD / 250k TPM free via Google AI Studio. Per-user rate limit recommended for teams. Note: EU/UK/Swiss users require paid tier |

---

## Recommended AI Agent Capabilities (Skills)

For the **Gemini agent running inside the workflow**, it needs exactly the 4 tools above (`get_file_tree`, `read_file`, `search_code`, `write_fix`). No file system access, no shell execution, no external network calls beyond what the tools expose — all side effects are mediated through the defined function-calling interface.

SDK: **`@google/genai`** (the new unified SDK — `@google/generative-ai` was deprecated Nov 2025).

Gemini function calling uses `FunctionDeclaration` schemas. The loop pattern with `@google/genai`:

```ts
const ai = new GoogleGenAI({ apiKey: GOOGLE_AI_API_KEY });
const chat = ai.chats.create({ model: "gemini-2.5-flash", config: { tools } });
// loop:
const response = await chat.sendMessage({ message });
if (response.functionCalls) {
  /* dispatch, send functionResponse */
}
// repeat until write_fix called
```

For Claude Code (building this system):

- Reading and writing TypeScript
- Calling Bitbucket, Monday, Google AI, and Slack REST APIs
- Understanding Pipedream's workflow-as-code structure
- Using `@google/genai` SDK's function calling / chat API

---

## Verification / Testing Plan

1. **Unit test tool handlers** — mock Bitbucket API, assert `read_file` truncation, `search_code` output format
2. **Test Monday GraphQL query** — use Monday API playground with a real item ID
3. **Test agent loop** — run `gemini_agent.ts` standalone with a hardcoded issue + repo; verify `write_fix` is always the terminal call
4. **Test Bitbucket PR creation** — create a test repo, run `execute_decision` with a dummy fix, verify branch + PR appear
5. **End-to-end on Pipedream** — trigger `/fix-issue` from Slack with a real Monday item pointing to the test repo; verify Slack response arrives with either PR link or analysis
6. **Permissions check** — verify the App Password cannot delete branches, merge PRs, or access other workspaces
