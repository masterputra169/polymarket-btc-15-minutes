#!/usr/bin/env bash
# POLY//15 auto-deploy (pull model): GitHub push -> CI success -> guarded switch.
set -Eeuo pipefail

REPO="/opt/polybtc15"
BRANCH="main"
REMOTE="origin"
REPO_SLUG="masterputra169/polymarket-btc-15-minutes"
STATE_DIR="$REPO/.auto-deploy"
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$STATE_DIR/auto-deploy.log"
LOCK_FILE="$STATE_DIR/deploy.lock"
LAST_BLOCK=""
BOT_ENV="$REPO/bot/.env"
TMP=""
BACKUP=""
OLD_SHA=""
TARGET=""
SHORT=""
AUTH_CHANGED=0
SWITCH_STARTED=0

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt 1048576 ]; then mv "$LOG_FILE" "$LOG_FILE.1"; fi
fi

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG_FILE"; }

state_get() {
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$STATE_FILE" | head -1
}

write_state() {
  cat > "$STATE_FILE" <<EOF
{"deployed_sha":"$DEPLOYED_SHA","last_seen_sha":"$LAST_SEEN_SHA","last_result":"$LAST_RESULT","at":"$(date -Is)"}
EOF
}

DEPLOYED_SHA=$(state_get deployed_sha)
LAST_SEEN_SHA=$(state_get last_seen_sha)
LAST_RESULT=$(state_get last_result)

TG_TOKEN=""
TG_CHAT=""
if [ -f "$BOT_ENV" ]; then
  TG_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$BOT_ENV" | cut -d= -f2- | tr -d '\r"' || true)
  TG_CHAT=$(grep -m1 '^TELEGRAM_CHAT_ID=' "$BOT_ENV" | cut -d= -f2- | tr -d '\r"' || true)
fi

notify() {
  [ -n "$TG_TOKEN" ] || return 0
  [ -n "$TG_CHAT" ] || return 0
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$TG_CHAT" --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

bot_env_dry() {
  [ -f "$BOT_ENV" ] || { echo missing; return 0; }
  grep -m1 '^DRY_RUN=' "$BOT_ENV" | cut -d= -f2- | tr -d '\r"' || true
}

state_position() {
  if [ ! -f "$REPO/bot/data/state.json" ]; then echo flat; return 0; fi
  node -e 'const fs=require("fs");try{const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(s.currentPosition&&!s.currentPosition.settled?"open":"flat")}catch(e){console.log("unknown")}' "$REPO/bot/data/state.json"
}

status_snapshot() {
  if ! systemctl is-active --quiet polybtc15-bot 2>/dev/null; then echo inactive; return 0; fi
  local token
  token=$(grep -m1 '^STATUS_AUTH_TOKEN=' "$BOT_ENV" | cut -d= -f2- | tr -d '\r"' || true)
  if [ -z "$token" ]; then echo unknown; return 0; fi
  STATUS_TOKEN="$token" node -e '
    const WebSocket=require("/opt/polybtc15/bot/node_modules/ws");
    const ws=new WebSocket("ws://127.0.0.1:3099/ws?token="+encodeURIComponent(process.env.STATUS_TOKEN||""));
    const timer=setTimeout(()=>{console.log("timeout");try{ws.terminate()}catch(e){};process.exit(0)},4000);
    ws.on("message",d=>{let m;try{m=JSON.parse(d.toString())}catch(e){return};if(!m||typeof m.dryRun!=="boolean"||!m.positions)return;console.log(JSON.stringify({dryRun:m.dryRun,paused:!!m.paused,position:!!m.positions.botPosition}));clearTimeout(timer);try{ws.close()}catch(e){};process.exit(0)});
    ws.on("error",()=>{console.log("error");clearTimeout(timer);process.exit(0)});
  ' 2>/dev/null || echo unknown
}

block_deploy() {
  local reason="$1"
  local key="$TARGET:$reason"
  LAST_BLOCK="$key"
  log "blocked: $reason"
  if [ "$key" != "$LAST_BLOCK" ]; then
    printf '%s\n' "$key" > "$STATE_DIR/last-block"
    notify "POLY//15 auto-deploy blocked: $reason"
  fi
  exit 0
}

guard() {
  local dry snap pos
  dry=$(bot_env_dry)
  if [ "$dry" != "true" ]; then block_deploy "live mode (DRY_RUN=$dry)"; fi
  pos=$(state_position)
  if [ "$pos" = "open" ]; then block_deploy "paper position open"; fi
  if [ "$pos" = "unknown" ]; then block_deploy "position state unreadable"; fi
  snap=$(status_snapshot)
  if [ "$snap" = "inactive" ]; then log "bot inactive; deploy will heal"; return 0; fi
  if [ "$snap" = "timeout" ]; then block_deploy "bot status timeout"; fi
  if [ "$snap" = "error" ]; then block_deploy "bot status error"; fi
  if [ "$snap" = "unknown" ]; then block_deploy "bot status unknown"; fi
  case "$snap" in
    *\"dryRun\":false*) block_deploy "live mode from status" ;;
    *\"paused\":true*) block_deploy "bot paused" ;;
    *\"position\":true*) block_deploy "position open from status" ;;
  esac
}

ci_state() {
  local target="$1" json
  json=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' -H 'User-Agent: poly15-auto-deploy' \
    "https://api.github.com/repos/$REPO_SLUG/commits/$target/check-runs") || { echo api-error; return 0; }
  printf '%s' "$json" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("api-error");return}const runs=j.check_runs||[];if(!runs.length){console.log("pending");return}if(runs.some(r=>r.status!=="completed")){console.log("pending");return}console.log(runs.every(r=>r.conclusion==="success")?"ready":"failed")});
  '
}

wait_http() {
  local url="$1" i=0
  while [ "$i" -lt 30 ]; do
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && return 0
    i=$((i+1)); sleep 1
  done
  return 1
}

cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then git -C "$REPO" worktree remove --force "$TMP" >/dev/null 2>&1 || rm -rf "$TMP"; fi
  if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then rm -rf "$BACKUP"; fi
}

rollback() {
  log "ROLLING BACK to $OLD_SHA"
  sudo -n systemctl stop polybtc15-bot >/dev/null 2>&1 || true
  git -C "$REPO" reset --hard "$OLD_SHA" >/dev/null 2>&1 || true
  rm -rf "$REPO/node_modules" "$REPO/bot/node_modules" "$REPO/dist"
  if [ -d "$BACKUP/root_node_modules" ]; then mv "$BACKUP/root_node_modules" "$REPO/node_modules"; fi
  if [ -d "$BACKUP/bot_node_modules" ]; then mv "$BACKUP/bot_node_modules" "$REPO/bot/node_modules"; fi
  if [ -d "$BACKUP/dist" ]; then mv "$BACKUP/dist" "$REPO/dist"; fi
  sudo -n systemctl start polybtc15-bot >/dev/null 2>&1 || true
  if [ "$AUTH_CHANGED" = "1" ]; then sudo -n systemctl restart polybot-dashboard-auth >/dev/null 2>&1 || true; fi
}

on_exit() {
  local code=$?
  trap - EXIT
  if [ "$SWITCH_STARTED" = "1" ]; then
    rollback
    LAST_RESULT="rolled-back"
    write_state
    notify "POLY//15 auto-deploy failed; rolled back to $OLD_SHA"
  fi
  cleanup
  exit "$code"
}
trap on_exit EXIT

cd "$REPO"
git fetch --prune "$REMOTE" "$BRANCH" >/dev/null 2>&1 || { log "git fetch failed"; notify "POLY//15 auto-deploy: git fetch failed"; exit 0; }
TARGET=$(git rev-parse "$REMOTE/$BRANCH")
SHORT=$(printf '%.7s' "$TARGET")

if [ "$TARGET" = "$DEPLOYED_SHA" ] || [ "$TARGET" = "$LAST_SEEN_SHA" ]; then exit 0; fi
log "target $SHORT (deployed $DEPLOYED_SHA, seen $LAST_SEEN_SHA)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "worktree dirty; refusing to overwrite"
  notify "POLY//15 auto-deploy: worktree dirty; manual cleanup required"
  exit 1
fi

CI=$(ci_state "$TARGET")
case "$CI" in
  ready) log "CI success" ;;
  pending) log "CI pending; retry next timer"; exit 0 ;;
  failed)
    LAST_SEEN_SHA="$TARGET"; LAST_RESULT="ci-failed"; write_state
    log "CI failed; not deploying"; notify "POLY//15 auto-deploy: CI failed for $SHORT"; exit 1 ;;
  *) log "CI status unavailable; retry next timer"; exit 0 ;;
esac

CHANGED=$(git diff --name-only "$DEPLOYED_SHA" "$TARGET" 2>/dev/null || true)
DOCS_ONLY=1
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    analysis/*|docs/*|ml_registry/*|.github/*|UPDATES.md|README.md|CLAUDE.md|*.md) ;;
    *) DOCS_ONLY=0; break ;;
  esac
done <<< "$CHANGED"
if [ "$DOCS_ONLY" = "1" ]; then
  LAST_SEEN_SHA="$TARGET"; LAST_RESULT="docs-only"; write_state
  log "docs-only; no server deploy"; exit 0
fi

guard
log "building $SHORT in temp worktree"
TMP=$(mktemp -d /home/ubuntu/poly15-deploy-XXXXXX)
git -C "$REPO" worktree add --detach "$TMP" "$TARGET" >/dev/null
if ! (cd "$TMP" && npm ci --no-audit --no-fund && npm ci --prefix bot --no-audit --no-fund && npm run build); then
  log "build failed"; LAST_SEEN_SHA="$TARGET"; LAST_RESULT="build-failed"; write_state
  notify "POLY//15 auto-deploy: build failed for $SHORT; bot untouched"; exit 1
fi
if [ ! -f "$TMP/dist/index.html" ] || [ ! -d "$TMP/node_modules" ] || [ ! -d "$TMP/bot/node_modules" ]; then
  log "artifacts missing"; LAST_SEEN_SHA="$TARGET"; LAST_RESULT="artifacts-missing"; write_state
  notify "POLY//15 auto-deploy: artifacts missing; bot untouched"; exit 1
fi

OLD_SHA=$(git rev-parse HEAD)
AUTH_CHANGED=0
[ "$(sha256sum "$REPO/scripts/dashboard-auth-server.mjs" | cut -d' ' -f1)" = "$(sha256sum "$TMP/scripts/dashboard-auth-server.mjs" | cut -d' ' -f1)" ] || AUTH_CHANGED=1
BACKUP=$(mktemp -d /home/ubuntu/poly15-deploy-backup-XXXXXX)
log "switching (auth_changed=$AUTH_CHANGED)"
SWITCH_STARTED=1
sudo -n systemctl stop polybtc15-bot >/dev/null
git -C "$REPO" reset --hard "$TARGET" >/dev/null
if [ -d "$REPO/node_modules" ]; then mv "$REPO/node_modules" "$BACKUP/root_node_modules"; fi
if [ -d "$REPO/bot/node_modules" ]; then mv "$REPO/bot/node_modules" "$BACKUP/bot_node_modules"; fi
if [ -d "$REPO/dist" ]; then mv "$REPO/dist" "$BACKUP/dist"; fi
mv "$TMP/node_modules" "$REPO/node_modules"
mv "$TMP/bot/node_modules" "$REPO/bot/node_modules"
mv "$TMP/dist" "$REPO/dist"
sudo -n systemctl start polybtc15-bot >/dev/null
if [ "$AUTH_CHANGED" = "1" ]; then sudo -n systemctl restart polybot-dashboard-auth >/dev/null; fi
sleep 8
systemctl is-active --quiet polybtc15-bot || { log "bot not active"; exit 1; }
wait_http "http://127.0.0.1:3101/health" || { log "bot health failed"; exit 1; }
wait_http "http://127.0.0.1:3102/health" || { log "auth health failed"; exit 1; }
curl -fsS --max-time 5 "http://127.0.0.1:8080/" | grep -q 'id="root"' || { log "dashboard check failed"; exit 1; }
SWITCH_STARTED=0
DEPLOYED_SHA="$TARGET"; LAST_SEEN_SHA="$TARGET"; LAST_RESULT="success"; write_state
rm -rf "$BACKUP"; BACKUP=""
log "deployed $SHORT"
notify "POLY//15 auto-deploy success: $SHORT (DRY RUN)"
