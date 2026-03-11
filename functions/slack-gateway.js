import crypto from "crypto";
import { PubSub } from "@google-cloud/pubsub";

const pubsub = new PubSub();

export async function slackGateway(req, res) {
  if (!verifySlackSignature(req)) {
    res.status(401).send("Unauthorized");
    return;
  }

  if (req.path === "/slash") {
    await handleSlashCommand(req, res);
  } else if (req.path === "/interactivity") {
    await handleInteractivity(req, res);
  } else {
    res.status(404).send("Not found");
  }
}

function verifySlackSignature(req) {
  const signature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];

  if (!signature || !timestamp) return false;

  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body)).toString();
  const hmac = crypto
    .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(`v0=${hmac}`),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

async function handleSlashCommand(req, res) {
  const body = req.body;
  const triggerId = body.trigger_id;
  const channelId = body.channel_id;
  const userId = body.user_id;

  const response = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "fix_issue_modal",
        private_metadata: JSON.stringify({ channelId, userId }),
        title: { type: "plain_text", text: "Fix Issue" },
        submit: { type: "plain_text", text: "Analyze" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "monday_url",
            label: { type: "plain_text", text: "Monday Task URL" },
            element: {
              type: "plain_text_input",
              action_id: "value",
              placeholder: {
                type: "plain_text",
                text: "https://monday.com/boards/.../items/...",
              },
            },
          },
          {
            type: "input",
            block_id: "repo_select",
            label: { type: "plain_text", text: "Repo(s)" },
            element: {
              type: "multi_static_select",
              action_id: "value",
              placeholder: { type: "plain_text", text: "Select repos..." },
              options: [
                {
                  text: { type: "plain_text", text: "participant-app-client-ionic-vue" },
                  value: "participant-app-client-ionic-vue",
                },
                {
                  text: { type: "plain_text", text: "participant-app-api" },
                  value: "participant-app-api",
                },
                {
                  text: { type: "plain_text", text: "participant-app-server" },
                  value: "participant-app-server",
                },
                {
                  text: { type: "plain_text", text: "portal-service" },
                  value: "portal-service",
                },
                {
                  text: { type: "plain_text", text: "portal-front" },
                  value: "portal-front",
                },
                {
                  text: { type: "plain_text", text: "registration-seeder" },
                  value: "registration-seeder",
                },
                {
                  text: { type: "plain_text", text: "cloudsso" },
                  value: "cloudsso",
                },
                {
                  text: { type: "plain_text", text: "applicant-data" },
                  value: "applicant-data",
                },
                {
                  text: { type: "plain_text", text: "birthrightisrael-public-website" },
                  value: "birthrightisrael-public-website",
                },
              ],
            },
          },
          {
            type: "input",
            block_id: "repo_other",
            optional: true,
            label: { type: "plain_text", text: "Other repo(s) not in list" },
            element: {
              type: "plain_text_input",
              action_id: "value",
              placeholder: {
                type: "plain_text",
                text: "my-other-repo another-repo",
              },
            },
          },
          {
            type: "input",
            block_id: "branch",
            label: { type: "plain_text", text: "Target branch" },
            optional: true,
            element: {
              type: "plain_text_input",
              action_id: "value",
              initial_value: "staging",
            },
          },
          {
            type: "input",
            block_id: "context",
            label: { type: "plain_text", text: "Additional context (optional)" },
            optional: true,
            element: {
              type: "plain_text_input",
              action_id: "value",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "I think the issue is in the auth middleware...",
              },
            },
          },
        ],
      },
    }),
  });

  const result = await response.json();
  if (!result.ok) throw new Error(`views.open failed: ${result.error}`);

  res.status(200).send("");
}

async function handleInteractivity(req, res) {
  // Slack sends interactivity payloads as URL-encoded form data
  const rawPayload = req.body.payload ?? req.body;
  const payloadString =
    typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);

  // Respond immediately — Slack requires 200 within 3 seconds
  res.status(200).send("");

  // Publish to Pub/Sub for async processing
  const topic = pubsub.topic("run-pipeline");
  await topic.publishMessage({ data: Buffer.from(payloadString) });
}
