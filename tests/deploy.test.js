import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { releaseConfig, previousConfig } from "../scripts/deploy-config.js";

test("release config preserves the shared working directory and rollback process settings", () => {
  const config = releaseConfig({
    release: "/app/.releases/new",
    appDir: "/app",
    name: "aetheris",
    envFile: "/app/.env",
    port: 8080,
    revision: "abc",
  }).apps[0];
  assert.equal(config.cwd.replaceAll("\\", "/").endsWith("/app"), true);
  assert.equal(
    config.script.replaceAll("\\", "/").endsWith("/app/.releases/new/index.js"),
    true,
  );
  assert.equal(config.instances, 1);
  assert.equal(config.env.AETHERIS_RELEASE, "abc");
  const before = {
    name: "aetheris",
    pm2_env: {
      pm_exec_path: "/old/index.js",
      pm_cwd: "/app",
      node_args: ["--env-file=/app/.env"],
      env: { CUSTOM: "kept" },
      args: ["--old"],
    },
  };
  const rollback = previousConfig([before], "aetheris").apps[0];
  assert.equal(rollback.script, "/old/index.js");
  assert.deepEqual(rollback.env, { CUSTOM: "kept" });
  assert.deepEqual(rollback.args, ["--old"]);
  assert.equal(previousConfig([], "aetheris"), null);
});

const bash =
  process.platform === "win32"
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash";
const available = process.platform !== "win32" || existsSync(bash);
const posix = (path) =>
  process.platform === "win32"
    ? path
        .replaceAll("\\", "/")
        .replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase())
    : path;

for (const scenario of [
  "success",
  "bootstrap",
  "checks",
  "validate",
  "reload",
  "restart",
  "health",
  "proxy",
  "recovery",
]) {
  test(`staged deploy simulation: ${scenario}`, { skip: !available }, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "aetheris-deploy-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const app = join(dir, "app"),
      bin = join(dir, "bin"),
      payload = join(dir, "payload");
    mkdirSync(app);
    mkdirSync(bin);
    mkdirSync(join(payload, "scripts"), { recursive: true });
    copyFileSync(
      new URL("../deploy.sh", import.meta.url),
      join(app, "deploy.sh"),
    );
    if (scenario === "bootstrap") copyFileSync(join(app, "deploy.sh"), join(dir, "bootstrap.sh"));
    writeFileSync(join(app, ".env"), "PORT=8080\n");
    writeFileSync(join(app, "index.js"), "old code");
    writeFileSync(join(payload, "index.js"), "new code");
    writeFileSync(join(payload, "Caddyfile"), "new config");
    writeFileSync(join(dir, "caddy.conf"), "old config");
    const stub = (name, body) =>
      writeFileSync(
        join(bin, name),
        `#!/bin/bash\nprintf '%s %s\\n' '${name}' "$*" >> "$TRACE"\n${body}\n`,
        { mode: 0o755 },
      );
    stub(
      "git",
      `case "$1" in rev-parse) printf '%040d\\n' 1;; archive) tar -cf - -C "$PAYLOAD" .;; esac`,
    );
    stub(
      "pnpm",
      `if [[ "$SCENARIO" == checks && "$1" == lint ]]; then exit 1; fi`,
    );
    stub(
      "caddy",
      `if [[ "$SCENARIO" == validate && "$1" == validate ]]; then exit 1; fi\nif [[ "$SCENARIO" == reload && "$1" == reload ]] && grep -q 'new config' "$CADDY_CONFIG"; then exit 1; fi`,
    );
    stub(
      "pm2",
      `if [[ "$1" == jlist ]]; then echo '[]'; fi\nif [[ "$SCENARIO" == restart && "$1" == start && "$2" == *'.releases/'* ]]; then exit 1; fi`,
    );
    stub(
      "node",
      `if [[ "$2" == snapshot ]]; then echo '{}' > "$4"; elif [[ "$2" == release ]]; then echo '{}' > "$9"; elif [[ ( "$SCENARIO" == proxy || "$SCENARIO" == recovery ) && "$1" == *wisp-check.js ]]; then exit 1; elif [[ "$SCENARIO" == recovery && "$1" == *recover-storage.js ]]; then exit 1; fi`,
    );
    stub(
      "curl",
      `if [[ "$SCENARIO" == health && "$*" == *healthz* ]]; then echo '{"release":"wrong"}'; else echo '{"release":"0000000000000000000000000000000000000001"}'; fi`,
    );
    stub("ln", `printf '%s' "$2" > "$3"`);
    stub("sleep", `exit 0`);
    const harness = join(dir, "run.sh");
    writeFileSync(
      harness,
      'export PATH="$STUBS:$PATH"\nexec bash "$APP_SCRIPT"\n',
    );
    const result = spawnSync(bash, [posix(harness)], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        APP_DIR: posix(app),
        STUBS: posix(bin),
        APP_SCRIPT: posix(scenario === "bootstrap" ? join(dir, "bootstrap.sh") : join(app, "deploy.sh")),
        PAYLOAD: posix(payload),
        TRACE: posix(join(dir, "trace")),
        CADDY_CONFIG: posix(join(dir, "caddy.conf")),
        SCENARIO: scenario,
      },
    });
    assert.equal(
      result.status,
      scenario === "success" || scenario === "bootstrap" ? 0 : 1,
      result.stdout + result.stderr,
    );
    const trace = readFileSync(join(dir, "trace"), "utf8");
    assert.equal(
      readFileSync(join(app, "index.js"), "utf8"),
      "old code",
      "staging never writes into the live source files",
    );
    if (scenario === "success" || scenario === "bootstrap") {
      assert.equal(readFileSync(join(dir, "caddy.conf"), "utf8"), "new config");
      assert.match(trace, /git merge --ff-only/);
      assert.match(trace, /pm2 delete aetheris[\s\S]*pm2 start .*\.releases\//);
    } else {
      assert.equal(readFileSync(join(dir, "caddy.conf"), "utf8"), "old config");
      assert.doesNotMatch(trace, /git merge --ff-only/);
      if (scenario === "checks" || scenario === "validate")
        assert.doesNotMatch(trace, /pm2 start /);
      else if (scenario === "recovery") {
        assert.doesNotMatch(trace, /pm2 start .*previous-pm2.json/);
        assert.match(result.stderr, /app left stopped/);
      } else assert.match(trace, /pm2 start .*previous-pm2.json/);
    }
    assert.equal(existsSync(join(app, ".deploy-lock")), false);
    assert.equal(readdirSync(join(app, ".releases")).length, 1);
  });
}
