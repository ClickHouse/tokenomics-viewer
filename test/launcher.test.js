"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const {
  browserCommand,
  dashboardReady,
  downloadClickHouseInstaller,
  ensureClickHouse,
  findExecutable,
  launcherAppArgs,
  launcherDataPath,
  parseLauncherArgs,
  runLauncher,
  waitForDashboardProcess,
} = require("../lib/launcher");

async function withStatusServer(payload, callback) {
  const http = require("node:http");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("dashboard readiness requires a loopback sync-capable endpoint and the selected engine", async () => {
  await withStatusServer({ sync: { available: false, engine: "clickhouse", state: "running" } }, async (url) => {
    assert.equal(await dashboardReady(url, "clickhouse"), false);
  });
  await withStatusServer({ sync: { available: true, engine: "sqlite", state: "running" } }, async (url) => {
    assert.equal(await dashboardReady(url, "clickhouse"), false);
  });
  await withStatusServer({ sync: { available: true, engine: "clickhouse", state: "running" } }, async (url) => {
    assert.equal(await dashboardReady(url, "clickhouse"), true);
  });
});

test("ClickHouse installer requests the shell payload and rejects HTML", async () => {
  let requestOptions = null;
  const shellScript = await downloadClickHouseInstaller(async (_url, options) => {
    requestOptions = options;
    return {
      ok: true,
      status: 200,
      url: "https://clickhouse.com/cli",
      headers: { get: (name) => name === "content-type" ? "text/plain; charset=utf-8" : null },
      text: async () => "#!/bin/sh\nset -eu\n",
    };
  });

  assert.equal(shellScript, "#!/bin/sh\nset -eu\n");
  assert.match(requestOptions.headers["user-agent"], /^curl\//);
  assert.equal(requestOptions.headers.accept, "text/plain");

  await assert.rejects(
    downloadClickHouseInstaller(async () => ({
      ok: true,
      status: 200,
      url: "https://clickhouse.com/docs/interfaces/cli",
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () => "<!doctype html><title>ClickHouse CLI</title>",
    })),
    /returned HTML instead of a shell script/,
  );
});

test("launcher finds an installed chctl even when ~/.local/bin is absent from PATH", async (t) => {
  const temporary = await fs.mkdtemp(Path.join(Os.tmpdir(), "tokenomics-launcher-path-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const localBin = Path.join(temporary, ".local", "bin");
  const executable = Path.join(localBin, "chctl");
  await fs.mkdir(localBin, { recursive: true });
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  assert.equal(await findExecutable("chctl", { PATH: "/usr/bin:/bin" }, temporary), executable);
});

test("browser command uses the platform default opener", () => {
  const url = "http://127.0.0.1:8787";
  assert.deepEqual(browserCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(browserCommand("linux", url), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand("win32", url), { command: "cmd", args: ["/c", "start", "", url] });
});

test("launcher arguments keep orchestration flags separate from app arguments", () => {
  assert.deepEqual(parseLauncherArgs([
    "--clickhouse",
    "--no-open",
    "--port", "9001",
    "--",
    "--source", "codex",
  ]), {
    forceEngine: "clickhouse",
    noOpen: true,
    port: 9001,
    appArgs: ["--source", "codex"],
  });
  assert.equal(parseLauncherArgs(["--no-clickhouse"]).forceEngine, "sqlite");
  assert.throws(() => parseLauncherArgs(["--sqlite", "--clickhouse"]), /only one/);
  assert.throws(() => parseLauncherArgs(["--port", "nope"]), /port/);
});

test("launcher defaults to ClickHouse without loading state or prompting", async () => {
  const calls = [];
  const exitCode = await runLauncher(["--no-open"], {
    loadState: async () => { throw new Error("must not load legacy choice state"); },
    ask: async () => { throw new Error("must not prompt"); },
    clickhouseDetected: async () => { throw new Error("must not run a choice probe"); },
    dashboardReady: async (_url, engine) => { calls.push(["probe", engine]); return false; },
    ensureClickHouse: async () => calls.push("clickhouse"),
    findAvailablePort: async () => 8791,
    spawnTokenomics: async (args) => {
      calls.push(["spawn", ...args]);
      return { exit: Promise.resolve(0), stop: () => calls.push("stop") };
    },
    waitForDashboard: async () => calls.push("ready"),
    log: () => {},
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    ["probe", "clickhouse"],
    "clickhouse",
    ["spawn", "--sync", "--webserver", "--host", "127.0.0.1", "--port", "8791", "--db-engine", "clickhouse"],
    "ready",
  ]);
});

test("ClickHouse setup skips installation when healthy", async () => {
  const calls = [];
  await ensureClickHouse({
    healthCheck: async () => true,
    findChctl: async () => { calls.push("find"); return "/bin/chctl"; },
    installChctl: async () => calls.push("install"),
    runCommand: async () => calls.push("run"),
    waitForHealth: async () => calls.push("wait"),
  });
  assert.deepEqual(calls, []);
});

test("ClickHouse setup installs CLI, selects stable, and starts the named server", async () => {
  const calls = [];
  let findCalls = 0;
  await ensureClickHouse({
    healthCheck: async () => false,
    findChctl: async () => (++findCalls === 1 ? null : "/home/user/.local/bin/chctl"),
    installChctl: async () => calls.push(["install"]),
    runCommand: async (command, args) => calls.push([command, ...args]),
    waitForHealth: async () => calls.push(["wait"]),
  });
  assert.deepEqual(calls, [
    ["install"],
    ["/home/user/.local/bin/chctl", "local", "use", "stable"],
    ["/home/user/.local/bin/chctl", "local", "server", "start", "--name", "tokenomics", "--http-port", "8123", "--tcp-port", "9000"],
    ["wait"],
  ]);
});

test("ClickHouse setup retries an existing named server without redefining ports", async () => {
  const calls = [];
  let startCalls = 0;
  await ensureClickHouse({
    healthCheck: async () => false,
    findChctl: async () => "/bin/chctl",
    installChctl: async () => { throw new Error("must not install"); },
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("--http-port") && ++startCalls === 1) throw new Error("server already exists");
    },
    waitForHealth: async () => calls.push(["wait"]),
  });
  assert.deepEqual(calls.at(-2), ["/bin/chctl", "local", "server", "start", "--name", "tokenomics"]);
  assert.deepEqual(calls.at(-1), ["wait"]);
});

test("launcher app arguments enforce sync and selected engine after user arguments", () => {
  assert.deepEqual(launcherAppArgs({
    engine: "clickhouse",
    port: 8789,
    appArgs: ["--source", "codex", "--no-sync"],
  }), [
    "--source", "codex", "--no-sync",
    "--sync", "--webserver", "--host", "127.0.0.1", "--port", "8789", "--db-engine", "clickhouse",
  ]);
});

test("launcher stores SQLite data outside the application release", () => {
  assert.equal(
    launcherDataPath({ TOKENOMICS_DATA_HOME: "/var/tokenomics-data" }, "/home/user"),
    Path.join("/var/tokenomics-data", "tokenomics-viewer", "tokenomics.sqlite"),
  );
  assert.equal(
    launcherDataPath({ XDG_DATA_HOME: "/home/user/.xdg-data" }, "/home/user"),
    Path.join("/home/user/.xdg-data", "tokenomics-viewer", "tokenomics.sqlite"),
  );
  assert.equal(
    launcherDataPath({}, "/home/user"),
    Path.join("/home/user", ".local", "share", "tokenomics-viewer", "tokenomics.sqlite"),
  );
});

test("launcher pins SQLite to its persistent data path", () => {
  assert.deepEqual(launcherAppArgs({
    engine: "sqlite",
    port: 8787,
    sqliteDb: "/data/tokenomics.sqlite",
    appArgs: ["--db", "/tmp/disposable.sqlite"],
  }), [
    "--db", "/tmp/disposable.sqlite",
    "--sync", "--webserver", "--host", "127.0.0.1", "--port", "8787",
    "--db-engine", "sqlite", "--db", "/data/tokenomics.sqlite",
  ]);
});

test("launcher reuses an existing dashboard and starts a protected sync", async () => {
  const calls = [];
  const exitCode = await runLauncher([], {
    dashboardReady: async (_url, engine) => { calls.push(["probe", engine]); return true; },
    triggerSync: async () => calls.push("sync"),
    openBrowser: async () => calls.push("open"),
    log: (message) => calls.push(message),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls[0], ["probe", "clickhouse"]);
  assert.ok(calls.includes("sync"));
  assert.ok(calls.includes("open"));
});

test("browser opener failure does not fail an otherwise ready dashboard", async () => {
  const messages = [];
  const exitCode = await runLauncher([], {
    dashboardReady: async () => true,
    triggerSync: async () => {},
    openBrowser: async () => { throw new Error("no opener"); },
    log: (message) => messages.push(message),
  });
  assert.equal(exitCode, 0);
  assert.ok(messages.some((message) => /could not open.*no opener/i.test(message)));
  assert.ok(messages.some((message) => /http:\/\/127\.0\.0\.1:8787/.test(message)));
});

test("SQLite opt-out skips ClickHouse setup and opens after readiness", async () => {
  const calls = [];
  const exitCode = await runLauncher(["--sqlite"], {
    dashboardReady: async (_url, engine) => { calls.push(["probe", engine]); return false; },
    ensureClickHouse: async () => { throw new Error("must not set up ClickHouse"); },
    findAvailablePort: async () => 8791,
    spawnTokenomics: async (args) => {
      calls.push(["spawn", ...args]);
      return { exit: Promise.resolve(0), stop: () => calls.push("stop") };
    },
    waitForDashboard: async () => calls.push("ready"),
    openBrowser: async () => calls.push("open"),
    sqliteDb: "/data/tokenomics.sqlite",
    interactive: false,
    log: () => {},
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    ["probe", "sqlite"],
    ["spawn", "--sync", "--webserver", "--host", "127.0.0.1", "--port", "8791", "--db-engine", "sqlite", "--db", "/data/tokenomics.sqlite"],
    "ready",
    "open",
  ]);
});

test("dashboard readiness fails promptly when the server process exits", async () => {
  await assert.rejects(
    waitForDashboardProcess(
      "http://127.0.0.1:8787",
      { exit: Promise.resolve(12) },
      async () => false,
      { timeoutMs: 10_000, intervalMs: 1 },
    ),
    /exit code 12/,
  );
});

test("default ClickHouse does not reuse a dashboard whose engine does not match", async () => {
  const calls = [];
  await runLauncher(["--no-open"], {
    dashboardReady: async (_url, engine) => { calls.push(["probe", engine]); return false; },
    triggerSync: async () => calls.push("reuse"),
    ensureClickHouse: async () => calls.push("clickhouse"),
    findAvailablePort: async () => 8792,
    spawnTokenomics: async () => ({ exit: Promise.resolve(0), stop: () => {} }),
    waitForDashboard: async () => calls.push("ready"),
    log: () => {},
  });
  assert.deepEqual(calls, [["probe", "clickhouse"], "clickhouse", "ready"]);
});
