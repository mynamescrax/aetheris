#!/bin/bash
# Stage and verify immutable code before changing the running app. Mutable
# state stays in APP_DIR; failures after activation restore PM2 and Caddy.
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)}"
APP_DIR="$(cd "$APP_DIR" && pwd -P)"
APP_NAME="${APP_NAME:-aetheris}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
CADDY_CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
RELEASE_ROOT="$APP_DIR/.releases"
ACTIVE_LINK="$APP_DIR/.current-release"
LOCK="$APP_DIR/.deploy-lock"
activated=false
state=""
prior_link=""

cd "$APP_DIR"
[[ "$APP_NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "Invalid APP_NAME" >&2; exit 1; }
for command in git tar pnpm node pm2 caddy curl; do
    command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
git diff --quiet && git diff --cached --quiet || { echo "Commit or preserve tracked changes before deploying." >&2; exit 1; }
[[ -f "$ENV_FILE" && -f "$CADDY_CONFIG" ]] || { echo "ENV_FILE and CADDY_CONFIG must exist before deploying." >&2; exit 1; }
[[ ! -e "$ACTIVE_LINK" || -L "$ACTIVE_LINK" ]] || { echo "$ACTIVE_LINK must be a symlink." >&2; exit 1; }
mkdir "$LOCK" || { echo "Another deploy holds $LOCK; inspect it before removing a stale lock." >&2; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

if [ -z "${PORT:-}" ]; then
    PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -n 1)"
fi
PORT="${PORT:-8080}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( 10#$PORT > 0 && 10#$PORT <= 65535 )) || { echo "Invalid PORT" >&2; exit 1; }

set_pointer() {
    local target="$1"
    if [ -n "$target" ]; then
        rm -f "$state/next-link"
        ln -s "$target" "$state/next-link"
        mv -Tf "$state/next-link" "$ACTIVE_LINK"
    else
        rm -f "$ACTIVE_LINK"
    fi
}

rollback() {
    local code="$1" line="$2"
    trap - ERR INT TERM
    echo "!! Deploy failed at line $line; staged files retained at ${release:-unknown}." >&2
    if [ "$activated" = true ]; then
        echo "-> Restoring previous release and Caddy configuration..." >&2
        set +e
        set_pointer "$prior_link"
        install -m 0644 "$state/Caddyfile" "$CADDY_CONFIG" || echo "!! Could not restore Caddyfile; use $state/Caddyfile manually." >&2
        caddy reload --config "$CADDY_CONFIG" || echo "!! Caddy rollback reload failed." >&2
        pm2 stop "$APP_NAME" >/dev/null 2>&1
        recovered=true
        node "$release/scripts/recover-storage.js" "$APP_DIR/database" || recovered=false
        if [ "$recovered" != true ]; then
            echo "!! Storage recovery failed; app left stopped to protect pending transactions." >&2
        elif [ -f "$state/previous-pm2.json" ]; then
            pm2 startOrRestart "$state/previous-pm2.json" --only "$APP_NAME" --update-env
        else
            pm2 delete "$APP_NAME"
        fi
        pm2 save
        if [ "$recovered" = true ] && [ -f "$state/previous-pm2.json" ]; then
            if ! curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 3 "http://127.0.0.1:$PORT/online-count" >/dev/null; then
                echo "!! Rollback health check failed; inspect PM2/Caddy. Recovery files: $state" >&2
            fi
        fi
    fi
    exit "$code"
}
trap 'rollback $? $LINENO' ERR
trap 'rollback 130 $LINENO' INT
trap 'rollback 143 $LINENO' TERM

echo "-> Fetching main without changing live files..."
git fetch origin main
revision="$(git rev-parse FETCH_HEAD)"
git merge-base --is-ancestor HEAD "$revision"
mkdir -p "$RELEASE_ROOT"
release="$(mktemp -d "$RELEASE_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}.XXXXXX")"
git archive "$revision" | tar -x -C "$release"

echo "-> Installing and verifying staged release..."
(
    cd "$release"
    pnpm install --frozen-lockfile
    if [ "${SKIP_CHECKS:-0}" != "1" ]; then
        pnpm lint
        pnpm check
        pnpm test
    fi
    caddy validate --adapter caddyfile --config "$release/Caddyfile" >/dev/null
)

# wispurr requires musl on Linux. A missing loader leaves the existing wisp-js
# fallback available; installing host packages is an explicit operator action.
if [ "$(uname -s)" = Linux ] && [ ! -e "/lib/ld-musl-$(uname -m).so.1" ]; then
    echo "!! musl is missing; install it to enable wispurr (wisp-js will be used)." >&2
fi

state="$(mktemp -d "$APP_DIR/.deploy-state.XXXXXX")"
cp "$CADDY_CONFIG" "$state/Caddyfile"
pm2 jlist > "$state/pm2.json"
node "$release/scripts/deploy-config.js" snapshot "$APP_NAME" "$state/previous-pm2.json" < "$state/pm2.json"
node "$release/scripts/deploy-config.js" release "$release" "$APP_DIR" "$APP_NAME" "$ENV_FILE" "$PORT" "$revision" "$release/pm2.json"
if [ -L "$ACTIVE_LINK" ]; then prior_link="$(readlink "$ACTIVE_LINK")"; fi

activated=true
set_pointer "$release"
install -m 0644 "$release/Caddyfile" "$CADDY_CONFIG"
caddy reload --config "$CADDY_CONFIG"
pm2 startOrRestart "$release/pm2.json" --only "$APP_NAME" --update-env

healthy=false
for _ in {1..40}; do
    response="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
    if [[ "$response" == *"\"release\":\"$revision\""* ]]; then healthy=true; break; fi
    sleep 0.5
done
if [ "$healthy" != true ]; then echo "!! New release did not become healthy." >&2; false; fi
proxy_rc=0
node "$release/scripts/wisp-check.js" "$PORT" || proxy_rc=$?
if [ "$proxy_rc" -ne 0 ] && [ "$proxy_rc" -ne 2 ]; then echo "!! Proxy health check failed." >&2; false; fi
pm2 save
activated=false

# The source checkout is no longer the live code directory. Advance it only
# after success so the next invocation uses the latest deployment tooling.
if ! git merge --ff-only "$revision"; then echo "!! Release is healthy, but source checkout could not fast-forward." >&2; fi
echo "Done: $revision. Previous-release recovery files: $state"
