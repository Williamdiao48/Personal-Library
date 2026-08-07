#!/usr/bin/env bash
# Thin build + deploy for the Phase 4 extraction container.
#
# Codifies the exact, security-critical deploy flags so a redeploy can never
# silently drop --no-allow-unauthenticated (the ENTIRE auth boundary) or
# --max-instances (the real cost brake). Prefer this over re-typing the commands
# from memory. Full context: docs/internal/planning/cloud/phase-4-gcp-setup.md (Part C).
#
#   ./server/cloud-run/extract/deploy.sh
#
# The Docker build CONTEXT is the repo root (the image bundles the shared
# electron/main/capture extractor), so this script cd's there before building.
# Overridable via env: PROJECT_ID, REGION, SERVICE, REPO, TAG.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-extract}"
REPO="${REPO:-pl-containers}"
TAG="${TAG:-latest}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "PROJECT_ID is unset and no gcloud default project is configured." >&2
  echo "Run: gcloud config set project <PROJECT_ID>   (or PROJECT_ID=… $0)" >&2
  exit 1
fi

IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:$TAG"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

echo "▶ Building $IMAGE"
echo "  (context: $REPO_ROOT — bundles the shared electron/main/capture extractor)"
cd "$REPO_ROOT"
gcloud builds submit \
  --project "$PROJECT_ID" \
  --config server/cloud-run/extract/cloudbuild.yaml \
  --substitutions=_IMAGE="$IMAGE" \
  .

echo "▶ Deploying $SERVICE — PRIVATE, per-instance isolation, cost-capped"
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --image "$IMAGE" \
  --region "$REGION" \
  --no-allow-unauthenticated \
  --ingress=all \
  --memory=1Gi \
  --cpu=1 \
  --concurrency=1 \
  --timeout=120 \
  --max-instances=3 \
  --min-instances=0

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "✔ Deployed: $SERVICE_URL"
echo "  (→ this is the CLOUD_RUN_URL Supabase secret; verify with Part F of the runbook)"
