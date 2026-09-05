"use strict";

const ChildProcess = require("node:child_process");
const Fs = require("node:fs");
const Net = require("node:net");
const Os = require("node:os");
const Path = require("node:path");
const fsp = Fs.promises;

const CLICKHOUSE_URL = "http://127.0.0.1:8123";
const INSTALLER_URL = "https://clickhouse.com/cli";
const DEFAULT_PORT = 8787;

function parseLauncherArgs(argv) {
  const options = {
    forceEngine: null,
    noOpen: false,
    port: DEFAULT_PORT,
    appArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.appArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "--sqlite" || arg === "--no-clickhouse" || arg === "--clickhouse") {
      const engine = arg === "--clickhouse" ? "clickhouse" : "sqlite";
      if (options.forceEngine && options.forceEngine !== engine) {
        throw new Error("Choose only one database backend flag");
      }
      options.forceEngine = engine;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--port") {
      options.port = Number(argv[++index]);
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown launcher option: ${arg}. Pass Tokenomics options after --.`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Launcher port must be an integer from 1 to 65535");
  }
  return options;
}

function launcherHelpText() {
  return `Usage: ./launcher.js [launcher options] [-- tokenomics options]

Options:
  --sqlite, --no-clickhouse   Opt out of ClickHouse and use SQLite for this launch
  --clickhouse                Explicitly use ClickHouse (the default)
  --port PORT                 Preferred dashboard port (default: ${DEFAULT_PORT})
  --no-open                   Start the dashboard without opening a browser
  -h, --help                  Show this help

ClickHouse is the default backend and is installed automatically when needed.
`;
}

function launcherDataDirectory(env = process.env, home = Os.homedir()) {
  const base = env.TOKENOMICS_DATA_HOME
    || env.XDG_DATA_HOME
    || Path.join(home, ".local", "share");
  return Path.join(base, "tokenomics-viewer");
}

function launcherDataPath(env = process.env, home = Os.homedir()) {
  return Path.join(launcherDataDirectory(env, home), "tokenomics.sqlite");
}


async function ensureClickHouse({
  healthCheck,
  findChctl,
  installChctl,
  projectDirectory,
  runCommand,
  waitForHealth,
}) {
  if (await healthCheck()) return;
  let chctl = await findChctl();
  if (!chctl) {
    await installChctl();
    chctl = await findChctl();
  }
  if (!chctl) throw new Error("clickhousectl installation completed but chctl was not found in PATH or ~/.local/bin");

  const commandOptions = projectDirectory ? { cwd: projectDirectory } : undefined;
  if (projectDirectory) await fsp.mkdir(projectDirectory, { recursive: true });

  await runCommand(chctl, ["local", "use", "stable"], commandOptions);
  try {
    await runCommand(chctl, [
      "local", "server", "start",
      "--name", "tokenomics",
      "--http-port", "8123",
      "--tcp-port", "9000",
    ], commandOptions);
  } catch (createError) {
    try {
      await runCommand(
        chctl,
        ["local", "server", "start", "--name", "tokenomics"],
        commandOptions,
      );
    } catch {
      throw createError;
    }
  }
  await waitForHealth();
}

function launcherAppArgs({ engine, port, sqliteDb, appArgs = [] }) {
  const args = [
    ...appArgs,
    "--sync",
    "--webserver",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--db-engine", engine,
  ];
  if (engine === "sqlite") args.push("--db", sqliteDb);
  return args;
}

function commandPromise(child, label) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(0);
      else reject(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

async function runCommand(command, args, options = {}) {
  const child = ChildProcess.spawn(command, args, {
    stdio: options.stdio || "inherit",
    cwd: options.cwd,
    env: options.env || process.env,
  });
  return commandPromise(child, `${command} ${args.join(" ")}`);
}

async function downloadClickHouseInstaller(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(INSTALLER_URL, {
    redirect: "follow",
    headers: {
      accept: "text/plain",
      // clickhouse.com currently serves documentation HTML to Node's default UA.
      "user-agent": "curl/8.0.0",
    },
  });
  if (!response.ok) throw new Error(`Cannot download clickhousectl installer: HTTP ${response.status}`);
  const script = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (/text\/html/i.test(contentType) || /^\s*<!doctype\s+html/i.test(script) || /^\s*<html\b/i.test(script)) {
    throw new Error(`ClickHouse installer URL returned HTML instead of a shell script (${response.url || INSTALLER_URL})`);
  }
  if (!script || Buffer.byteLength(script) > 2 * 1024 * 1024) {
    throw new Error("clickhousectl installer response was empty or unexpectedly large");
  }
  if (!/^#!\/bin\/sh(?:\r?\n|\s)/.test(script)) {
    throw new Error("clickhousectl installer response has an unexpected format");
  }
  return script;
}

async function installChctl() {
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("The automatic clickhousectl installer currently supports macOS and Linux only");
  }
  const script = await downloadClickHouseInstaller();
  const child = ChildProcess.spawn("/bin/sh", [], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.end(script);
  await commandPromise(child, "clickhousectl installer");
}

async function findExecutable(name, env = process.env, home = Os.homedir()) {
  const directories = [
    ...(env.PATH || "").split(Path.delimiter).filter(Boolean),
    Path.join(home, ".local", "bin"),
  ];
  for (const directory of [...new Set(directories)]) {
    const candidate = Path.join(directory, name);
    try {
      await fsp.access(candidate, Fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the bounded executable path list.
    }
  }
  return null;
}

async function httpOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500), cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function dashboardReady(baseUrl, expectedEngine = null) {
  try {
    const response = await fetch(`${baseUrl}/api/sync`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await response.json();
    if (!body?.sync || body.sync.available !== true) return false;
    if (!expectedEngine) return true;
    const engine = body.sync.engine || body.sync.result?.engine;
    return engine === expectedEngine;
  } catch {
    return false;
  }
}

async function triggerSync(baseUrl) {
  const response = await fetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: { "x-tokenomics-action": "sync" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Existing dashboard rejected sync: HTTP ${response.status}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(check, { timeoutMs = 120_000, intervalMs = 500, label = "service" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForDashboardProcess(
  url,
  child,
  ready = dashboardReady,
  { timeoutMs = 30 * 60_000, intervalMs = 500 } = {},
) {
  let exited = false;
  let exitCode = null;
  child.exit.then((code) => {
    exited = true;
    exitCode = code;
  });
  await waitUntil(async () => {
    if (exited) throw new Error(`Tokenomics exited before becoming ready with exit code ${exitCode}`);
    return ready(url);
  }, { timeoutMs, intervalMs, label: "Tokenomics dashboard" });
}

async function portAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = Net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function findAvailablePort(preferredPort) {
  for (let port = preferredPort; port <= Math.min(65535, preferredPort + 20); port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`No available dashboard port found from ${preferredPort} through ${Math.min(65535, preferredPort + 20)}`);
}

function spawnTokenomics(args) {
  const root = Path.resolve(__dirname, "..");
  const child = ChildProcess.spawn(process.execPath, [Path.join(root, "app.js"), ...args], {
    cwd: root,
    stdio: "inherit",
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  return {
    exit,
    stop: () => child.kill("SIGTERM"),
  };
}

function browserCommand(platform, url) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

async function openBrowser(url) {
  const opener = browserCommand(process.platform, url);
  return runCommand(opener.command, opener.args, { stdio: "ignore" });
}

async function openBrowserSafely(runtime, url, noOpen) {
  if (noOpen) return;
  try {
    await runtime.openBrowser(url);
  } catch (error) {
    runtime.log(`Could not open the browser automatically: ${error.message}`);
    runtime.log(`Open ${url} manually.`);
  }
}

function defaultRuntime() {
  const clickhouseHealth = () => httpOk(`${CLICKHOUSE_URL}/ping`);
  const dataDirectory = launcherDataDirectory();
  return {
    sqliteDb: Path.join(dataDirectory, "tokenomics.sqlite"),
    log: console.log,
    dashboardReady,
    triggerSync,
    ensureClickHouse: () => ensureClickHouse({
      healthCheck: clickhouseHealth,
      findChctl: async () => await findExecutable("chctl") || await findExecutable("clickhousectl"),
      installChctl,
      projectDirectory: dataDirectory,
      runCommand,
      waitForHealth: () => waitUntil(clickhouseHealth, { timeoutMs: 120_000, label: "ClickHouse" }),
    }),
    findAvailablePort,
    spawnTokenomics,
    waitForDashboard: (url, child) => waitForDashboardProcess(url, child),
    openBrowser,
  };
}

async function runLauncher(argv, dependencies = {}) {
  const options = parseLauncherArgs(argv);
  const runtime = { ...defaultRuntime(), ...dependencies };
  if (options.help) {
    runtime.log(launcherHelpText());
    return 0;
  }

  const engine = options.forceEngine || "clickhouse";

  const preferredUrl = `http://127.0.0.1:${options.port}`;
  if (await runtime.dashboardReady(preferredUrl, engine)) {
    runtime.log(`Reusing dashboard at ${preferredUrl}`);
    await runtime.triggerSync(preferredUrl);
    await openBrowserSafely(runtime, preferredUrl, options.noOpen);
    return 0;
  }

  if (engine === "clickhouse") await runtime.ensureClickHouse();

  const port = await runtime.findAvailablePort(options.port);
  const url = `http://127.0.0.1:${port}`;
  const args = launcherAppArgs({
    engine,
    port,
    sqliteDb: runtime.sqliteDb,
    appArgs: options.appArgs,
  });
  runtime.log(`Starting Tokenomics with ${engine} at ${url}`);
  const child = await runtime.spawnTokenomics(args);
  try {
    await runtime.waitForDashboard(url, child);
  } catch (error) {
    child.stop();
    throw error;
  }
  runtime.log(`Tokenomics dashboard is available at ${url}; synchronization continues in the background.`);
  await openBrowserSafely(runtime, url, options.noOpen);
  return child.exit;
}

module.exports = {
  CLICKHOUSE_URL,
  browserCommand,
  dashboardReady,
  downloadClickHouseInstaller,
  ensureClickHouse,
  findExecutable,
  launcherAppArgs,
  launcherDataDirectory,
  launcherDataPath,
  launcherHelpText,
  parseLauncherArgs,
  runLauncher,
  waitForDashboardProcess,
};
