#!/usr/bin/env bash
# Runs on the server: /opt/renoviq/deploy.sh <image>
# Example:            /opt/renoviq/deploy.sh myuser/renoviq-backend:abc1234
# Pulls the image, restarts the api container and waits until its health check passes.
# If the new version never becomes healthy, the previous image is started again.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${1:?usage: deploy.sh <image>}"
PREVIOUS="$(cat .current-image 2>/dev/null || true)"

healthy() {
  local id state restarts
  for _ in $(seq 1 45); do # up to 90 seconds
    id="$(docker compose ps -q api)"
    state="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
    restarts="$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)"
    [ "$state" = healthy ] && return 0
    # Give up early when the container keeps crashing.
    if [ "$state" = unhealthy ] || [ "${restarts:-0}" -ge 3 ]; then return 1; fi
    sleep 2
  done
  return 1
}

export IMAGE
docker compose pull api
docker compose up -d api

if healthy; then
  echo "$IMAGE" > .current-image
  docker image prune -f > /dev/null
  echo "Deployed $IMAGE"
  exit 0
fi

echo "$IMAGE did not become healthy. Last log lines:" >&2
docker compose logs --tail 40 api >&2 || true
if [ -n "$PREVIOUS" ]; then
  echo "Rolling back to $PREVIOUS" >&2
  IMAGE="$PREVIOUS" docker compose up -d api
  healthy && echo "Rollback is healthy" >&2 || echo "Rollback is NOT healthy either" >&2
fi
exit 1
