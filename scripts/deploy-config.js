import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseConfig({
  release,
  appDir,
  name,
  envFile,
  port,
  revision,
}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid PM2 app name.");
  return {
    apps: [
      {
        name,
        script: join(resolve(release), "index.js"),
        // Keep all mutable state at the original application directory. Code and
        // static assets are resolved relative to their immutable release files.
        cwd: resolve(appDir),
        node_args: [`--env-file=${resolve(envFile)}`],
        exec_mode: "fork",
        instances: 1,
        max_memory_restart: "2G",
        kill_timeout: 5000,
        env: { PORT: String(port), AETHERIS_RELEASE: revision },
      },
    ],
  };
}

export function previousConfig(processes, name) {
  const process = processes.find((entry) => entry.name === name);
  if (!process) return null;
  const env = process.pm2_env;
  if (!env?.pm_exec_path || !env.pm_cwd)
    throw new Error("Incomplete PM2 process snapshot.");
  return {
    apps: [
      {
        name,
        script: env.pm_exec_path,
        cwd: env.pm_cwd,
        interpreter: env.exec_interpreter,
        node_args: env.node_args,
        args: env.args,
        exec_mode: env.exec_mode,
        instances: 1,
        max_memory_restart: env.max_memory_restart,
        kill_timeout: env.kill_timeout,
        autorestart: env.autorestart,
        env: env.env || {},
      },
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, ...args] = process.argv.slice(2);
  let config, destination;
  if (mode === "release") {
    const [release, appDir, name, envFile, port, revision, out] = args;
    config = releaseConfig({ release, appDir, name, envFile, port, revision });
    destination = out;
  } else if (mode === "snapshot") {
    const [name, out] = args;
    config = previousConfig(JSON.parse(readFileSync(0, "utf8")), name);
    destination = out;
  } else throw new Error("Use release or snapshot.");
  if (config)
    writeFileSync(destination, JSON.stringify(config), { mode: 0o600 });
}
