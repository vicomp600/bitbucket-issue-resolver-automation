# Taglibot

An AI-powered Slack bot that automatically triages and fixes bugs by reading your Bitbucket codebase, analyzing Monday.com issues, and opening pull requests — all from a single slash command.

---

## How It Works

A user triggers `/fix-issue` in Slack, fills out a modal, and the bot takes over:

1. **Slack modal** — user provides a Monday.com issue URL, target repos, branch, and optional context
2. **Gateway** — validates the Slack request and publishes a job to a Pub/Sub topic
3. **parse-slack-data** — decodes the modal payload, extracts fields (Monday ID, repos, branch, context)
4. **fetch-monday-issue** — queries Monday.com via GraphQL for the issue title, column values, and comments; opens a Slack thread to report progress
5. **fetch-repo-tree** — fetches the root file tree of all selected repos from Bitbucket in parallel
6. **agent-plan-loop** — a Gemini AI agent iteratively reads files, searches code, and decides whether to produce a fix or a detailed analysis report
7. **notify-plan** — posts the agent's findings and confidence score to the Slack thread
8. **apply-fix** — if the agent decided to fix (confidence ≥ 75%, ≤ 8 files changed), commits the changes to a new branch and opens a pull request on Bitbucket

```
User (Slack)
    │  /fix-issue
    ▼
┌─────────────────────┐
│   slack-gateway     │  Cloud Function — HTTP trigger
│  (HTTP, 30s)        │  • Verifies Slack signature
└────────┬────────────┘  • Opens modal on slash command
         │ Pub/Sub: run-pipeline
         ▼
┌─────────────────────┐
│   run-pipeline      │  Cloud Function — Pub/Sub trigger
│  (512MB, 9min)      │
│                     │
│  parse-slack-data   │
│  fetch-monday-issue │──► Slack thread (progress updates)
│  fetch-repo-tree    │──► Bitbucket API
│  agent-plan-loop    │──► Gemini AI + Bitbucket code search
│  notify-plan        │──► Slack thread (analysis/fix summary)
│  apply-fix          │──► Bitbucket PR
└─────────────────────┘
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) — for posting messages and opening modals |
| `SLACK_SIGNING_SECRET` | Slack app signing secret — used to verify request authenticity |
| `MONDAY_API_TOKEN` | Monday.com API v2 token — for fetching issue details via GraphQL |
| `BITBUCKET_WORKSPACE` | Bitbucket workspace slug (lowercase, e.g. `myworkspace`) |
| `BITBUCKET_USERNAME` | Bitbucket account email — used for Basic auth |
| `BITBUCKET_API_KEY` | Bitbucket API key / app password — paired with username for auth |
| `GOOGLE_AI_API_KEY` | Google AI Studio API key — for Gemini model access |

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

---

## Deploying to GCP

### Prerequisites

- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A GCP project with Cloud Functions and Pub/Sub APIs enabled
- A Pub/Sub topic named `run-pipeline`:
  ```bash
  gcloud pubsub topics create run-pipeline --project=taglibot
  ```

### Deploy

Deploy both functions:

```bash
./deploy.sh
```

Deploy only the pipeline (e.g. after updating agent logic):

```bash
./deploy.sh --pipeline
```

Deploy only the gateway (e.g. after updating the modal):

```bash
./deploy.sh --gateway
```

The script loads your `.env` file automatically and prints the gateway URL at the end. Set that URL as your Slack app's slash command request URL and interactivity request URL.

### Slack App Configuration

In your Slack app settings:

- **Slash Commands** → Request URL: `https://<gateway-url>/slash`
- **Interactivity & Shortcuts** → Request URL: `https://<gateway-url>/interactivity`

---

## Project Structure

```
functions/
├── index.js                  # Exports both Cloud Functions
├── slack-gateway.js          # HTTP entry point — Slack verification, modal, Pub/Sub publish
├── run-pipeline.js           # Orchestrator — chains all steps
└── steps/
    ├── parse-slack-data.js   # Decodes Pub/Sub payload, extracts modal fields
    ├── fetch-monday-issue.js # Monday.com GraphQL query, opens Slack thread
    ├── fetch-repo-tree.js    # Lists Bitbucket file trees (parallel per repo)
    ├── agent-plan-loop.js    # Gemini AI agentic loop — reads code, decides fix/analyze
    ├── notify-plan.js        # Posts analysis results to Slack thread
    └── apply-fix.js          # Commits files, opens PR on Bitbucket
deploy.sh                     # GCP deployment script
.env.example                  # Environment variable template
```
