#!/usr/bin/env bash
# Boots the image with a minimal env and checks readiness, non-root user and image size (AC-0.2, AC-0.6).
set -euo pipefail
IMAGE="${1:-rooster:ci}"
NAME="rooster-smoke-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -p 127.0.0.1::3000 \
  -e ROOSTER_BASE_URL=http://localhost:3000 \
  -e ROOSTER_AUTH_SECRET="$(head -c 48 /dev/urandom | base64)" \
  -e ROOSTER_ADMIN_EMAILS=admin@example.com \
  -e ROOSTER_OIDC_PROVIDERS='[{"id":"dev","name":"Dev login","discoveryUrl":"http://127.0.0.1:9/.well-known/openid-configuration","clientId":"smoke","clientSecret":"smoke"}]' \
  "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 3000 | head -1 | sed 's/.*://')"

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/readyz" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ "$i" == 30 ]]; then echo "readyz never became ready"; docker logs "$NAME"; exit 1; fi
done
echo "✓ /readyz ok"
curl -fsS "http://127.0.0.1:${PORT}/api/v1/meta" | grep -q '"id":"dev"' \
  && echo "✓ /api/v1/meta lists the sign-in provider" || { echo "✗ /api/v1/meta has no provider"; exit 1; }
ME_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/me")"
[[ "$ME_STATUS" == 401 ]] && echo "✓ /api/v1/me requires a session" || { echo "✗ /api/v1/me → $ME_STATUS"; exit 1; }
curl -fsS "http://127.0.0.1:${PORT}/api/docs" >/dev/null && echo "✓ /api/docs ok"
curl -fsS "http://127.0.0.1:${PORT}/" | grep -qi "<html" && echo "✓ web app served"

USER_ID="$(docker inspect --format '{{.Config.User}}' "$IMAGE")"
[[ "$USER_ID" == "nonroot" || "$USER_ID" == "65532" ]] && echo "✓ runs as non-root ($USER_ID)" || { echo "✗ user=$USER_ID"; exit 1; }

SIZE=$(docker image inspect "$IMAGE" --format '{{.Size}}')
SIZE_MB=$((SIZE / 1024 / 1024))
(( SIZE_MB < 250 )) && echo "✓ image size ${SIZE_MB} MB" || { echo "✗ image size ${SIZE_MB} MB ≥ 250"; exit 1; }
APP_LAYER_MB=$(docker history "$IMAGE" --format '{{.Size}} {{.CreatedBy}}' --human=false | awk '/COPY .*\/app/ {print int($1/1024/1024)}' | head -1)
(( APP_LAYER_MB < 50 )) && echo "✓ app layer ${APP_LAYER_MB} MB" || { echo "✗ app layer ${APP_LAYER_MB} MB ≥ 50"; exit 1; }

# AC-0.3: missing required config exits with EX_CONFIG (78)
set +e
docker run --rm "$IMAGE" >/dev/null 2>&1
CODE=$?
set -e
[[ "$CODE" == 78 ]] && echo "✓ missing config exits 78" || { echo "✗ exit code $CODE (expected 78)"; exit 1; }
