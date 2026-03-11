import * as ff from "@google-cloud/functions-framework";
import { run as parseSlackData } from "./steps/parse-slack-data.js";
import { run as fetchMondayIssue } from "./steps/fetch-monday-issue.js";
import { run as fetchRepoTree } from "./steps/fetch-repo-tree.js";
import { run as agentPlanLoop } from "./steps/agent-plan-loop.js";
import { run as notifyPlan } from "./steps/notify-plan.js";
import { run as applyFix } from "./steps/apply-fix.js";

ff.cloudEvent("runPipeline", runPipeline);

export async function runPipeline(cloudEvent) {
  // Pub/Sub message data is base64-encoded
  const rawPayload = Buffer.from(cloudEvent.data.message.data, "base64").toString();

  console.log("Pipeline triggered, payload length:", rawPayload.length);

  let parsedData;
  try {
    parsedData = await parseSlackData(rawPayload);
  } catch (error) {
    console.error("Failed to parse Slack payload:", error.message);
    return; // Can't notify Slack without channel info — just log and exit
  }

  const { channelId } = parsedData;

  try {
    const mondayData = await fetchMondayIssue(parsedData);
    const repoData = await fetchRepoTree(parsedData);

    const agentResult = await agentPlanLoop({
      ...parsedData,
      ...mondayData,
      ...repoData,
    });

    await notifyPlan(agentResult);
    await applyFix(agentResult);

    console.log("Pipeline complete");
  } catch (error) {
    console.error("Pipeline failed:", error.message);

    // Best-effort Slack notification — if we have a thread_ts from Monday step, use it
    const thread_ts = parsedData?.thread_ts;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channelId,
        ...(thread_ts ? { thread_ts } : {}),
        text: `⚠️ Pipeline failed unexpectedly. Please check Cloud Logging for details.\n\n_Error: ${error.message}_`,
      }),
    });

    throw error; // Re-throw so GCP marks the Pub/Sub message as failed
  }
}
