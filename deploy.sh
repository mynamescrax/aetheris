#!/bin/bash
# Production deploy: pull, install, check, ship the Caddyfile, restart PM2.
# Env overrides: APP_NAME, ENV_FILE, PORT, SKIP_CHECKS=1 (skip lint/tests).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
APP_NAME="${APP_NAME:-aetheris}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

cd "$APP_DIR"

prev_rev="$(git rev-parse --short HEAD)"
trap 'echo "!! Deploy failed (line $LINENO). Was at $prev_rev before pulling." >&2' ERR

# The app reads PORT from its .env, so the health check has to as well.
if [ -z "${PORT:-}" ] && [ -f "$ENV_FILE" ]; then
    PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -n 1)"
fi
PORT="${PORT:-8080}"

echo "-> Pulling latest..."
git pull --ff-only

echo "-> Installing dependencies..."
pnpm install --frozen-lockfile

if [ "${SKIP_CHECKS:-0}" != "1" ]; then
    echo "-> Running lint + tests..."
    pnpm lint
    pnpm test
fi

echo "-> Validating + installing Caddyfile..."
# Validate the repo copy and install it, so /etc/caddy/Caddyfile can't drift
# from the reviewed file in the repo.
caddy validate --adapter caddyfile --config "$APP_DIR/Caddyfile" > /dev/null
install -m 0644 "$APP_DIR/Caddyfile" /etc/caddy/Caddyfile

echo "-> Reloading Caddy..."
caddy reload --config /etc/caddy/Caddyfile

echo "-> Restarting app..."
# Kill orphaned Aetheris processes (not PM2's own) so the restart can bind the
# port. Match on 'index.js' alone: PM2 runs `node --env-file=... index.js`.
managed_pids="$(pm2 pid "$APP_NAME" 2>/dev/null | tr -d '\r' || true)"
orphan_pids=()
for pid in $(pgrep -f 'index\.js' 2>/dev/null || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" = "$APP_DIR" ] || continue
    managed=false
    for managed_pid in $managed_pids; do
        if [ "$pid" = "$managed_pid" ]; then
            managed=true
        fi
    done
    if [ "$managed" = false ]; then
        echo "-> Stopping orphaned Aetheris PID $pid..."
        kill "$pid" 2>/dev/null || true
        orphan_pids+=("$pid")
    fi
done

# Wait for every orphan to release its listener before restarting.
for pid in ${orphan_pids[@]+"${orphan_pids[@]}"}; do
    for _ in {1..50}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
        echo "-> Orphan PID $pid ignored SIGTERM; sending SIGKILL..."
        kill -KILL "$pid" 2>/dev/null || true
        for _ in {1..20}; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
    fi
done

if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    pm2 restart "$APP_NAME"
else
    pm2 start index.js \
        --name "$APP_NAME" \
        --cwd "$APP_DIR" \
        --node-args="--env-file=$ENV_FILE" \
        --kill-timeout 5000
    pm2 save
fi

# A restart that never binds is still a failed deploy.
if command -v curl > /dev/null 2>&1; then
    healthy=false
    for _ in {1..40}; do
        if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/online-count" > /dev/null 2>&1; then
            healthy=true
            break
        fi
        sleep 0.5
    done
    if [ "$healthy" = true ]; then
        echo "-> Health check OK"
    else
        echo "!! Health check FAILED: app is not answering on 127.0.0.1:$PORT" >&2
        echo "!! Check: pm2 logs $APP_NAME --err" >&2
        exit 1
    fi
else
    echo "-> curl not found; skipping post-restart health check"
fi

echo "Done ($prev_rev -> $(git rev-parse --short HEAD))"
