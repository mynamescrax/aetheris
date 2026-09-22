#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
APP_NAME="${APP_NAME:-aetheris}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

cd "$APP_DIR"

echo "-> Pulling latest..."
git pull --ff-only

echo "-> Installing dependencies..."
pnpm install --frozen-lockfile

echo "-> Validating + installing Caddyfile..."
# validate the repo copy, ship it, then reload — this keeps /etc/caddy/Caddyfile
# from drifting away from the reviewed file in the repo
caddy validate --adapter caddyfile --config "$APP_DIR/Caddyfile" > /dev/null
install -m 0644 "$APP_DIR/Caddyfile" /etc/caddy/Caddyfile

echo "-> Reloading Caddy..."
caddy reload --config /etc/caddy/Caddyfile

echo "-> Restarting app..."
# Kill only orphaned Aetheris instances before PM2 restarts its managed one.
# The previous loop also killed PM2's current PID, allowing PM2 to race us by
# spawning a replacement while the deploy was still cleaning up port 8080.
managed_pid="$(pm2 pid "$APP_NAME" 2>/dev/null || true)"
orphan_pids=()
for pid in $(pgrep -f 'node index\.js' 2>/dev/null || true); do
    if [ "$pid" != "$managed_pid" ] && [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$APP_DIR" ]; then
        echo "-> Stopping orphaned Aetheris PID $pid..."
        kill "$pid" 2>/dev/null || true
        orphan_pids+=("$pid")
    fi
done

# Do not restart until every orphan has actually released its listener.
for pid in "${orphan_pids[@]}"; do
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

echo "Done"
