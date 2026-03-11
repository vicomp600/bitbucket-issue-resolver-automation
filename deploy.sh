#!/bin/bash
set -e

# Load .env
export $(grep -v '^#' .env | grep -v '^$' | xargs)

REGION="us-central1"
PROJECT="taglibot"

GATEWAY_ENV_VARS="SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET=$SLACK_SIGNING_SECRET,BITBUCKET_WORKSPACE=$BITBUCKET_WORKSPACE"

PIPELINE_ENV_VARS="SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN,BITBUCKET_WORKSPACE=$BITBUCKET_WORKSPACE,BITBUCKET_USERNAME=$BITBUCKET_USERNAME,BITBUCKET_API_KEY=$BITBUCKET_API_KEY,MONDAY_API_TOKEN=$MONDAY_API_TOKEN,GOOGLE_AI_API_KEY=$GOOGLE_AI_API_KEY"

DEPLOY_GATEWAY=true
DEPLOY_PIPELINE=true

for arg in "$@"; do
  case $arg in
    --gateway)  DEPLOY_PIPELINE=false ;;
    --pipeline) DEPLOY_GATEWAY=false ;;
  esac
done

if [ "$DEPLOY_GATEWAY" = true ]; then
  echo "▶ Deploying slack-gateway..."
  gcloud functions deploy slackGateway \
    --project="$PROJECT" \
    --region="$REGION" \
    --gen2 \
    --runtime=nodejs22 \
    --trigger-http \
    --allow-unauthenticated \
    --memory=256MB \
    --timeout=30s \
    --entry-point=slackGateway \
    --set-env-vars="$GATEWAY_ENV_VARS"
fi

if [ "$DEPLOY_PIPELINE" = true ]; then
  echo "▶ Deploying run-pipeline..."
  gcloud functions deploy runPipeline \
    --project="$PROJECT" \
    --region="$REGION" \
    --gen2 \
    --runtime=nodejs22 \
    --trigger-topic=run-pipeline \
    --memory=512MB \
    --timeout=540s \
    --entry-point=runPipeline \
    --set-env-vars="$PIPELINE_ENV_VARS"
fi

echo "✅ Done!"
echo ""
echo "slack-gateway URL:"
gcloud functions describe slackGateway --project="$PROJECT" --region="$REGION" --format="value(serviceConfig.uri)" 2>/dev/null \
  || gcloud functions describe slackGateway --project="$PROJECT" --region="$REGION" --format="value(httpsTrigger.url)"