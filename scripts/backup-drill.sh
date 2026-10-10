#!/usr/bin/env bash
# The backup and restore drill (10 §3.6, AC-11.5), against a built image:
#
#   bash scripts/backup-drill.sh rooster:ci
#
# 1. Boots the image on a fresh volume, with the mock OIDC issuer (apps/server/test/mock-idp.ts)
#    on the host; signs in and creates data (a task with a subtask, a comment, an image
#    attachment), then takes a backup with POST /admin/backups and downloads it.
# 2. Creates more data after the backup, which the restore must roll back.
# 3. Stops the container and restores the snapshot in place, as 08 §7 tells operators: the
#    snapshot over /data/rooster.db, rooster.db-wal and rooster.db-shm deleted.
# 4. Starts a fresh container on the restored volume and checks the data.
# 5. Restores the downloaded copy into a new, empty volume (the off-site case) and checks it
#    there too.
# Exits non-zero on any failure; removes its containers, volumes and temp files.
#
# Needs Docker and Node 24 (the client and the issuer run on the host); the containers use the
# host network so that they and the client reach the issuer at the same URL.
set -euo pipefail

IMAGE="${1:-rooster:ci}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${DRILL_PORT:-3194}"
IDP_PORT="${DRILL_IDP_PORT:-9410}"
BASE="http://127.0.0.1:${PORT}"
ISSUER="http://127.0.0.1:${IDP_PORT}"
RUN_ID="rooster-drill-$$"
VOLUME="${RUN_ID}-data"
FRESH_VOLUME="${RUN_ID}-fresh"
WORK="$(mktemp -d)"
IDP_PID=""
SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"

cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    for c in "${RUN_ID}-a" "${RUN_ID}-b" "${RUN_ID}-c"; do
      docker logs --tail 30 "$c" 2>/dev/null | sed "s/^/[$c] /" || true
    done
  fi
  docker rm -f "${RUN_ID}-a" "${RUN_ID}-b" "${RUN_ID}-c" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" "$FRESH_VOLUME" >/dev/null 2>&1 || true
  if [[ -n "$IDP_PID" ]]; then kill "$IDP_PID" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
  if [[ $code -ne 0 ]]; then echo "✗ backup drill failed (exit $code)"; fi
  exit $code
}
trap cleanup EXIT

fail() { echo "✗ $*"; exit 1; }

# --- the mock OIDC issuer -------------------------------------------------------------------
node --input-type=module -e "
import { startMockIdp } from '${ROOT}/apps/server/test/mock-idp.ts';
const idp = await startMockIdp({ host: '127.0.0.1', port: ${IDP_PORT} });
console.log('issuer', idp.issuer);
process.once('SIGTERM', async () => { await idp.stop(); process.exit(0); });
" >"$WORK/idp.log" 2>&1 &
IDP_PID=$!
for i in $(seq 1 50); do
  curl -fsS "${ISSUER}/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 0.2
  [[ "$i" == 50 ]] && { cat "$WORK/idp.log"; fail "the mock issuer did not start"; }
done
PROVIDERS="[{\"id\":\"dev\",\"name\":\"Dev login\",\"discoveryUrl\":\"${ISSUER}/.well-known/openid-configuration\",\"clientId\":\"rooster-dev\",\"clientSecret\":\"rooster-dev-secret\"}]"

start_server() { # <container name> <volume>
  docker run -d --name "$1" --network host \
    -e PORT="$PORT" \
    -e ROOSTER_BASE_URL="$BASE" \
    -e ROOSTER_AUTH_SECRET="$SECRET" \
    -e ROOSTER_ADMIN_EMAILS=admin@example.com \
    -e ROOSTER_OIDC_PROVIDERS="$PROVIDERS" \
    -e ROOSTER_BACKUP_CRON=off \
    -v "$2:/data" \
    "$IMAGE" >/dev/null
  for i in $(seq 1 60); do
    curl -fsS "${BASE}/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  docker logs "$1"
  fail "$1 never became ready"
}

client() { # <step> — the API side of the drill, in Node (scripts/perf/http-session.mjs)
  DRILL_BASE="$BASE" DRILL_WORK="$WORK" node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { HttpSession } from '${ROOT}/scripts/perf/http-session.mjs';
const base = process.env.DRILL_BASE;
const work = process.env.DRILL_WORK;
const step = process.argv[1];
const admin = new HttpSession(base);
await admin.signIn('admin@example.com');
const titles = async () => {
  const list = await admin.ok('GET', '/api/v1/orgs/personal/my-list');
  return list.tasks.map((t) => t.title);
};
// A 1×1 PNG: an image attachment exercises sharp (the thumbnail) in the image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
if (step === 'seed') {
  const task = await admin.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Before the backup', dueDate: '2026-12-24' }, 201);
  await admin.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'A step', parentId: task.id }, 201);
  await admin.ok('POST', '/api/v1/tasks/' + task.id + '/comments', { body: 'Kept by the backup.' }, 201);
  const form = new FormData();
  form.append('file', new File([PNG], 'dot.png', { type: 'image/png' }));
  const up = await fetch(base + '/api/v1/tasks/' + task.id + '/attachments', {
    method: 'POST', body: form, headers: { cookie: admin.cookieHeader(), origin: base },
  });
  if (up.status !== 201) throw new Error('upload: ' + up.status + ' ' + (await up.text()));
  const attachment = await up.json();
  if (attachment.image?.thumb !== true) throw new Error('no thumbnail: sharp did not run');
  const backup = await admin.ok('POST', '/api/v1/admin/backups', undefined, 201);
  const file = await admin.call('GET', '/api/v1/admin/backups/' + encodeURIComponent(backup.name));
  if (file.status !== 200) throw new Error('download: ' + file.status);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new Error('the download is not SQLite');
  if (bytes.length !== backup.size) throw new Error('download size ' + bytes.length + ' != ' + backup.size);
  writeFileSync(work + '/snapshot.db', bytes);
  writeFileSync(work + '/state.json', JSON.stringify({ backup: backup.name, taskId: task.id, attachmentId: attachment.id }));
  // After the backup: the restore must roll this back.
  await admin.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'After the backup' }, 201);
  const now = await titles();
  if (!now.includes('After the backup')) throw new Error('seed: the second task is missing');
  console.log(backup.name);
} else {
  const state = JSON.parse(readFileSync(work + '/state.json', 'utf8'));
  const now = await titles();
  if (!now.includes('Before the backup') || !now.includes('A step')) throw new Error(step + ': data from before the backup is missing: ' + JSON.stringify(now));
  if (now.includes('After the backup')) throw new Error(step + ': data from after the backup survived the restore');
  const detail = await admin.ok('GET', '/api/v1/tasks/' + state.taskId);
  if (detail.attachments?.length !== 1) throw new Error(step + ': the attachment row is missing');
  const activity = await admin.ok('GET', '/api/v1/tasks/' + state.taskId + '/activity');
  if (!JSON.stringify(activity).includes('Kept by the backup.')) throw new Error(step + ': the comment is missing');
  if (step === 'in-place') {
    // Same volume: the attachment's file is still there.
    const blob = await admin.call('GET', '/api/v1/attachments/' + state.attachmentId);
    if (blob.status !== 200) throw new Error('attachment download: ' + blob.status);
  }
  const search = await admin.ok('GET', '/api/v1/search?q=' + encodeURIComponent('backup'));
  if (!JSON.stringify(search).includes('Before the backup')) throw new Error(step + ': search does not find the restored task');
}
" "$1"
}

# --- 1–2: data, backup, more data ------------------------------------------------------------
docker volume create "$VOLUME" >/dev/null
start_server "${RUN_ID}-a" "$VOLUME"
echo "✓ started $IMAGE on a fresh volume"
BACKUP="$(client seed | tail -1)"
[[ "$BACKUP" =~ ^manual-.*\.db$ ]] || fail "unexpected backup name: $BACKUP"
echo "✓ data created; backup $BACKUP taken and downloaded; more data created after it"

# --- 3: stop, restore in place (08 §7) -------------------------------------------------------
docker stop -t 20 "${RUN_ID}-a" >/dev/null
docker rm "${RUN_ID}-a" >/dev/null
# The image has no shell: its own Node copies the file, as the image's user (nonroot).
docker run --rm --network none -v "$VOLUME:/data" --entrypoint /nodejs/bin/node "$IMAGE" -e "
const fs = require('node:fs');
fs.copyFileSync('/data/backups/${BACKUP}', '/data/rooster.db');
for (const f of ['/data/rooster.db-wal', '/data/rooster.db-shm']) fs.rmSync(f, { force: true });
"
echo "✓ stopped; snapshot copied over rooster.db, WAL and SHM deleted"

# --- 4: a fresh container on the restored volume ---------------------------------------------
start_server "${RUN_ID}-b" "$VOLUME"
client in-place
echo "✓ restored in place: the backed-up data is there, later data is gone"
docker stop -t 20 "${RUN_ID}-b" >/dev/null

# --- 5: the downloaded copy into a new volume ------------------------------------------------
docker volume create "$FRESH_VOLUME" >/dev/null
chmod 0644 "$WORK/snapshot.db"
docker run --rm --network none -v "$FRESH_VOLUME:/data" -v "$WORK/snapshot.db:/restore/snapshot.db:ro" \
  --entrypoint /nodejs/bin/node "$IMAGE" -e "
require('node:fs').copyFileSync('/restore/snapshot.db', '/data/rooster.db');
"
start_server "${RUN_ID}-c" "$FRESH_VOLUME"
client off-site
echo "✓ restored the downloaded backup into a new volume: the data is there"
echo "✓ backup and restore drill passed"
